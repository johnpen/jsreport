const path = require('path')
const { nodeListToArray, isWorksheetFile, isWorksheetRelsFile, parseCellRef } = require('../utils')
const regexp = /{{#each ([^{}]{0,500})}}/

module.exports = (files) => {
  const workbookDoc = files.find((file) => file.path === 'xl/workbook.xml')?.doc
  const workbookRelsDoc = files.find((file) => file.path === 'xl/_rels/workbook.xml.rels')?.doc
  const sharedStringsDoc = files.find((f) => f.path === 'xl/sharedStrings.xml')?.doc
  const calcChainDoc = files.find((f) => f.path === 'xl/calcChain.xml')?.doc

  const workbookCalcPrEl = workbookDoc.getElementsByTagName('calcPr')[0]

  let workbookSheetsEls = []
  let workbookRelsEls = []
  let sharedStringsEls = []
  let calcChainEls = []

  if (workbookDoc) {
    workbookSheetsEls = nodeListToArray(workbookDoc.getElementsByTagName('sheet'))
  }

  if (workbookRelsDoc != null) {
    workbookRelsEls = nodeListToArray(workbookRelsDoc.getElementsByTagName('Relationship'))
  }

  if (sharedStringsDoc != null) {
    sharedStringsEls = nodeListToArray(sharedStringsDoc.getElementsByTagName('si'))
  }

  if (calcChainDoc != null) {
    calcChainEls = nodeListToArray(calcChainDoc.getElementsByTagName('c'))

    // we store the existing cell ref into other attribute
    // because later the attribute that contains the cell ref
    // is going to be updated
    for (const calcChainEl of calcChainEls) {
      calcChainEl.setAttribute('oldR', calcChainEl.getAttribute('r'))
    }
  }

  if (workbookCalcPrEl != null) {
    // set that this workbook should perform a full
    // recalculation when the workbook is opened
    workbookCalcPrEl.setAttribute('fullCalcOnLoad', '1')
  }

  const sharedStringElsToClean = []

  for (const f of files.filter((f) => isWorksheetFile(f.path))) {
    const sheetFilepath = f.path
    const sheetFilename = path.posix.basename(sheetFilepath)
    const sheetDoc = f.doc
    const sheetDataEl = sheetDoc.getElementsByTagName('sheetData')[0]

    if (sheetDataEl == null) {
      throw new Error(`Could not find sheet data for sheet at ${sheetFilepath}`)
    }

    const sheetInfo = getSheetInfo(sheetFilepath, workbookSheetsEls, workbookRelsEls)

    if (sheetInfo == null) {
      throw new Error(`Could not find sheet info for sheet at ${sheetFilepath}`)
    }

    const sheetRelsDoc = files.find((file) => isWorksheetRelsFile(sheetFilename, file.path))?.doc

    // wrap the <sheetData> into wrapper so we can store data during helper calls
    processOpeningTag(sheetDoc, sheetDataEl, "{{#xlsxSData type='root'}}")
    processClosingTag(sheetDoc, sheetDataEl, '{{/xlsxSData}}')

    // add <formulasUpdated> with a helper call so we can process and update
    // all the formulas references at the end of template processing
    const formulasUpdatedEl = sheetDoc.createElement('formulasUpdated')
    const formulasUpdatedItemsEl = sheetDoc.createElement('items')
    formulasUpdatedItemsEl.textContent = "{{xlsxSData type='formulas'}}"
    formulasUpdatedEl.appendChild(formulasUpdatedItemsEl)
    sheetDataEl.appendChild(formulasUpdatedEl)

    const mergeCellsEl = sheetDoc.getElementsByTagName('mergeCells')[0]
    const mergeCellEls = mergeCellsEl == null ? [] : nodeListToArray(mergeCellsEl.getElementsByTagName('mergeCell'))

    if (mergeCellsEl != null) {
      const mergeCellsUpdatedEl = sheetDoc.createElement('mergeCellsUpdated')
      // add <mergeCellsUpdated> with a helper call so we can process and update
      // all the merge cells references at the end of template processing
      const mergeCellsUpdatedItems = sheetDoc.createElement('items')

      mergeCellsUpdatedItems.textContent = '{{xlsxSData type="mergeCells"}}'

      mergeCellsUpdatedEl.appendChild(mergeCellsUpdatedItems)
      sheetDataEl.appendChild(mergeCellsUpdatedEl)
    }

    const dimensionEl = sheetDoc.getElementsByTagName('dimension')[0]

    if (dimensionEl != null) {
      // we add the dimension tag into the sheetData to be able to update
      // the ref by the handlebars
      const newDimensionEl = sheetDoc.createElement('dimensionUpdated')
      const refsParts = dimensionEl.getAttribute('ref').split(':')

      newDimensionEl.setAttribute('ref', `${refsParts[0]}:{{@meta.lastCellRef}}`)
      sheetDataEl.appendChild(newDimensionEl)
    }

    if (sheetRelsDoc != null) {
      const relationshipEls = nodeListToArray(sheetRelsDoc.getElementsByTagName('Relationship'))
      const tableRelEls = relationshipEls.filter((rel) => rel.getAttribute('Type') === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table')

      if (tableRelEls.length > 0) {
        const newTablesUpdatedEl = sheetDoc.createElement('tablesUpdated')

        for (const tableRelEl of tableRelEls) {
          const newTableUpdatedEl = sheetDoc.createElement('tableUpdated')

          const tablePath = path.join(path.posix.dirname(sheetFilepath), tableRelEl.getAttribute('Target'))

          newTableUpdatedEl.setAttribute('file', tablePath)

          const tableDoc = files.find((file) => file.path === tablePath)?.doc

          newTableUpdatedEl.setAttribute('ref', `{{xlsxSData type='newCellRef' originalCellRef='${tableDoc.documentElement.getAttribute('ref')}'}}`)

          const autoFilterEl = tableDoc.getElementsByTagName('autoFilter')[0]

          if (autoFilterEl != null) {
            const newAutoFilterRef = sheetDoc.createElement('autoFilterRef')
            newAutoFilterRef.setAttribute('ref', `{{xlsxSData type='newCellRef' originalCellRef='${autoFilterEl.getAttribute('ref')}'}}`)
            newTableUpdatedEl.appendChild(newAutoFilterRef)
          }

          newTablesUpdatedEl.appendChild(newTableUpdatedEl)
        }

        sheetDataEl.appendChild(newTablesUpdatedEl)
      }
    }

    const rowsEls = nodeListToArray(sheetDataEl.getElementsByTagName('row'))

    for (const rowEl of rowsEls) {
      let originalRowNumber = rowEl.getAttribute('r')
      const contentDetectCellElsToHandle = []
      const mergeCellElsToHandle = []
      const calcCellElsToHandle = []
      const formulaCellElsToHandle = []

      if (originalRowNumber == null || originalRowNumber === '') {
        throw new Error('Expected row to contain r attribute defined')
      }

      originalRowNumber = parseInt(originalRowNumber, 10)

      // wrap the <row> into wrapper so we can store data during helper calls
      processOpeningTag(sheetDoc, rowEl, `{{#xlsxSData type='row' originalRowNumber=${originalRowNumber}}}`)
      processClosingTag(sheetDoc, rowEl, '{{/xlsxSData}}')

      // update the row number to be based on helper call
      rowEl.setAttribute('r', "{{xlsxSData type='rowNumber'}}")

      const cellsEls = nodeListToArray(rowEl.getElementsByTagName('c'))
      let loopDetected

      for (const cellEl of cellsEls) {
        const cellRef = cellEl.getAttribute('r')

        cellEl.setAttribute('r', `{{xlsxSData type='cellRef' originalCellRef='${cellRef}'}}`)

        // search if we need to update some calc cell
        const calcCellEl = findCellElInCalcChain(sheetInfo.id, cellRef, calcChainEls)

        if (calcCellEl != null) {
          calcCellElsToHandle.push({
            calcCellEl,
            cellRef,
            cellEl
          })
        }

        const info = getCellInfo(cellEl, sharedStringsEls)

        if (
          info != null &&
          (info.type === 'inlineStr' ||
          info.type === 's')
        ) {
          // only do content detection for the cells with handlebars
          if (info.value.includes('{{') && info.value.includes('}}')) {
            contentDetectCellElsToHandle.push(cellEl)
          }

          if (
            loopDetected != null &&
            info.value.includes('{{/each}}')
          ) {
            loopDetected.end = {
              el: cellEl,
              cellRef,
              info
            }
          } else if (
            info.value.includes('{{#each') &&
            !info.value.includes('{{/each}}')
          ) {
            loopDetected = {
              start: {
                el: cellEl,
                cellRef,
                info
              }
            }
          }
        } else if (
          info != null &&
          info.type === 'str'
        ) {
          // if cell was error but detected as formula
          // we updated to formula
          if (cellEl.getAttribute('t') === 'e') {
            cellEl.setAttribute('t', info.type)
          }

          formulaCellElsToHandle.push({
            cellRef,
            cellEl
          })
        }

        // check if the cell starts a merge cell, if yes
        // then queue it to process it later
        const mergeCellEl = mergeCellEls.find((mergeCellEl) => {
          const ref = mergeCellEl.getAttribute('ref')
          return ref.startsWith(`${cellRef}:`)
        })

        if (mergeCellEl != null) {
          mergeCellElsToHandle.push({ ref: mergeCellEl.getAttribute('ref') })
        }
      }

      if (loopDetected != null && loopDetected.end == null) {
        throw new Error(`Unable to find end of loop (#each) in ${f.path}. {{/each}} is missing`)
      }

      if (loopDetected != null) {
        let currentCell = loopDetected.start.el

        // we should unset the cells that are using shared strings
        while (currentCell != null) {
          const currentCellInfo = getCellInfo(currentCell, sharedStringsEls)

          if (currentCellInfo != null) {
            if (currentCell === loopDetected.start.el) {
              if (currentCellInfo.type === 's') {
                sharedStringElsToClean.push(currentCellInfo.valueEl)
              } else {
                currentCellInfo.valueEl.textContent = currentCellInfo.valueEl.textContent.replace(regexp, '')
              }
            }

            if (currentCell === loopDetected.end.el) {
              if (currentCellInfo.type === 's') {
                sharedStringElsToClean.push(currentCellInfo.valueEl)
              } else {
                currentCellInfo.valueEl.textContent = currentCellInfo.valueEl.textContent.replace('{{/each}}', '')
              }
            }
          }

          if (currentCell === loopDetected.end.el) {
            currentCell = null
          } else {
            currentCell = currentCell.nextSibling
          }
        }

        const rowEl = loopDetected.start.el.parentNode
        const loopHelperCall = loopDetected.start.info.value.match(regexp)[0]

        if (loopDetected.start.el.previousSibling != null) {
          // we include a if condition to preserve the cells that are before the each
          processOpeningTag(sheetDoc, cellsEls[0], '{{#if @first}}')
          processClosingTag(sheetDoc, loopDetected.start.el.previousSibling, '{{/if}}')
        }

        if (loopDetected.end.el.nextSibling != null) {
          // we include a if condition to preserve the cells that are after the each
          processOpeningTag(sheetDoc, loopDetected.end.el.nextSibling, '{{#if @first}}')
          processClosingTag(sheetDoc, cellsEls[cellsEls.length - 1], '{{/if}}')
        }

        // we want to put the loop wrapper around the row wrapper
        processOpeningTag(sheetDoc, rowEl.previousSibling, loopHelperCall.replace(regexp, (match, valueInsideEachCall) => {
          return `{{#xlsxSData ${valueInsideEachCall} type='loop' start=${originalRowNumber} }}`
        }))

        // we want to put the loop wrapper around the row wrapper
        processClosingTag(sheetDoc, rowEl.nextSibling, '{{/xlsxSData}}')
      }

      for (const cellEl of contentDetectCellElsToHandle) {
        const cellInfo = getCellInfo(cellEl, sharedStringsEls)

        cellEl.setAttribute('__detectCellContent__', 'true')

        let newTextValue

        if (loopDetected != null && cellEl === loopDetected.start.el) {
          newTextValue = cellInfo.value.replace(regexp, '')
        } else if (loopDetected != null && cellEl === loopDetected.end.el) {
          newTextValue = cellInfo.value.replace('{{/each}}', '')
        } else {
          newTextValue = cellInfo.value
        }

        const newContentEl = sheetDoc.createElement('info')
        const cellValueWrapperEl = sheetDoc.createElement('xlsxRemove')
        const cellValueWrapperEndEl = sheetDoc.createElement('xlsxRemove')
        const rawEl = sheetDoc.createElement('raw')
        const typeEl = sheetDoc.createElement('type')
        const contentEl = sheetDoc.createElement('content')
        const handlebarsRegexp = /{{{?(#[a-z]+ )?([a-z]+[^\n\r}]*)}?}}/g
        const matches = Array.from(newTextValue.matchAll(handlebarsRegexp))
        const isSingleMatch = matches.length === 1 && matches[0][0] === newTextValue && matches[0][1] == null

        if (isSingleMatch) {
          const match = matches[0]
          const expressionValue = match[2]

          cellValueWrapperEl.textContent = `{{#xlsxSData type='cellValue' value=${expressionValue.includes(' ') ? `(${expressionValue})` : expressionValue}}}`
        } else {
          cellValueWrapperEl.textContent = "{{#xlsxSData type='cellValue'}}"
        }

        if (!isSingleMatch) {
          rawEl.textContent = `{{#xlsxSData type='cellValueRaw' }}${newTextValue}{{/xlsxSData}}`
        }

        typeEl.textContent = "{{xlsxSData type='cellValueType' }}"
        contentEl.textContent = "{{xlsxSData type='cellContent' }}"
        cellValueWrapperEndEl.textContent = '{{/xlsxSData}}'

        newContentEl.appendChild(cellValueWrapperEl)

        if (!isSingleMatch) {
          newContentEl.appendChild(rawEl)
        }

        newContentEl.appendChild(typeEl)
        newContentEl.appendChild(contentEl)
        newContentEl.appendChild(cellValueWrapperEndEl)

        cellEl.replaceChild(newContentEl, cellInfo.contentEl)
      }

      for (const { ref } of mergeCellElsToHandle) {
        // we want to put the all the mergeCell that affect this row
        // as its the last child
        const newMergeCellWrapperEl = sheetDoc.createElement('mergeCellUpdated')
        const newMergeCellEl = sheetDoc.createElement('mergeCell')

        let content = `type='mergeCell' originalCellRefRange='${ref}'`
        let fromLoop = false

        if (loopDetected != null) {
          const mergeStartCellRef = ref.split(':')[0]
          const parsedMergeStart = parseCellRef(mergeStartCellRef)
          const parsedLoopStart = parseCellRef(loopDetected.start.cellRef)
          const parsedLoopEnd = parseCellRef(loopDetected.end.cellRef)

          fromLoop = (
            parsedMergeStart.columnNumber >= parsedLoopStart.columnNumber &&
            parsedMergeStart.columnNumber <= parsedLoopEnd.columnNumber &&
            parsedMergeStart.rowNumber === parsedLoopStart.rowNumber
          )
        }

        if (fromLoop) {
          content += ' fromLoop=true'
        }

        newMergeCellEl.setAttribute('ref', `{{xlsxSData ${content}}}`)

        newMergeCellWrapperEl.appendChild(newMergeCellEl)
        rowEl.appendChild(newMergeCellWrapperEl)

        // if there is loop in row but the merge cell is not part
        // of it, we need to include a condition to only render
        // the mergeCellUpdated for the first item in the loop,
        // this is needed because we insert mergeCellUpdated nodes
        // inside the row
        if (loopDetected != null && !fromLoop) {
          processOpeningTag(sheetDoc, newMergeCellWrapperEl, '{{#if @first}}')
          processClosingTag(sheetDoc, newMergeCellWrapperEl, '{{/if}}')
        }
      }

      for (const { calcCellEl, cellRef, cellEl } of calcCellElsToHandle) {
        // we add the referenced cell in the calcChain in the cell
        // to be able to update the ref by the handlebars
        const newCalcCellEl = calcCellEl.cloneNode(true)

        newCalcCellEl.setAttribute('r', `{{xlsxSData type='cellRef' originalCellRef='${cellRef}'}}`)
        newCalcCellEl.setAttribute('oldR', cellRef)

        const wrapperElement = sheetDoc.createElement('calcChainCellUpdated')

        wrapperElement.appendChild(newCalcCellEl)
        // on the contrary with the merge cells case, the calcChainCellUpdated is inserted
        // in the cell, so there is no need for a wrapper that only renders it
        // for the first item in loop
        cellEl.insertBefore(wrapperElement, cellEl.firstChild)
      }

      for (const { cellEl, cellRef } of formulaCellElsToHandle) {
        const newFormulaWrapperEl = sheetDoc.createElement('formulaUpdated')
        const info = getCellInfo(cellEl, sharedStringsEls)
        let fromLoop = false

        let formulaContent = `type='formula' originalCellRef='${cellRef}' originalFormula='${info.value}'`

        if (loopDetected != null) {
          const parsedCell = parseCellRef(cellRef)
          const parsedLoopStart = parseCellRef(loopDetected.start.cellRef)
          const parsedLoopEnd = parseCellRef(loopDetected.end.cellRef)

          fromLoop = (
            parsedCell.columnNumber >= parsedLoopStart.columnNumber &&
            parsedCell.columnNumber <= parsedLoopEnd.columnNumber &&
            parsedCell.rowNumber === parsedLoopStart.rowNumber
          )
        }

        if (fromLoop) {
          formulaContent += ' fromLoop=true'
        }

        // on the contrary with the merge cells case, the formulaUpdated is inserted
        // in the cell, so there is no need for a wrapper that only renders it
        // for the first item in loop
        info.valueEl.setAttribute('formulaIndex', "{{xlsxSData type='formulaIndex'}}")
        info.valueEl.textContent = `{{xlsxSData ${formulaContent}}}`
        info.valueEl.parentNode.replaceChild(newFormulaWrapperEl, info.valueEl)
        newFormulaWrapperEl.appendChild(info.valueEl)
      }
    }
  }

  // clean the shared string values used in the loop items
  for (const sharedStringEl of sharedStringElsToClean) {
    sharedStringEl.textContent = ''
  }
}

function getSheetInfo (_sheetPath, workbookSheetsEls, workbookRelsEls) {
  const sheetPath = _sheetPath.startsWith('xl/') ? _sheetPath.replace(/^xl\//, '') : _sheetPath

  const sheetRefEl = workbookRelsEls.find((el) => (
    el.getAttribute('Type') === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' &&
    el.getAttribute('Target') === sheetPath
  ))

  if (sheetRefEl == null) {
    return
  }

  const sheetEl = workbookSheetsEls.find((el) => el.getAttribute('r:id') === sheetRefEl.getAttribute('Id'))

  if (sheetEl == null) {
    return
  }

  return {
    id: sheetEl.getAttribute('sheetId'),
    name: sheetEl.getAttribute('name'),
    rId: sheetRefEl.getAttribute('Id'),
    path: sheetPath
  }
}

function getCellInfo (cellEl, sharedStringsEls) {
  let type
  let value
  let valueEl
  let contentEl

  if (cellEl.childNodes.length === 0) {
    return
  }

  const explicitType = cellEl.getAttribute('t')
  const childEls = nodeListToArray(cellEl.childNodes)

  if (explicitType != null && explicitType !== '') {
    type = explicitType

    switch (explicitType) {
      case 'b':
      case 'd':
      case 'n': {
        const vEl = childEls.find((el) => el.nodeName === 'v')

        if (vEl != null) {
          value = vEl.textContent
          valueEl = vEl
          contentEl = vEl
        }

        break
      }
      case 'inlineStr': {
        const isEl = childEls.find((el) => el.nodeName === 'is')
        let tEl

        if (isEl != null) {
          tEl = nodeListToArray(isEl.childNodes).find((el) => el.nodeName === 't')
        }

        if (tEl != null) {
          value = tEl.textContent
          valueEl = tEl
          contentEl = isEl
        }

        break
      }
      case 's': {
        const vEl = childEls.find((el) => el.nodeName === 'v')
        let sharedIndex

        if (vEl != null) {
          sharedIndex = parseInt(vEl.textContent, 10)
        }

        let sharedStringEl

        if (sharedIndex != null && !isNaN(sharedIndex)) {
          sharedStringEl = sharedStringsEls[sharedIndex]
        }

        if (sharedStringEl == null) {
          throw new Error(`Unable to find shared string with index ${sharedIndex}`)
        }

        // the "t" node can be also wrapped in <si> and <r> when the text is styled
        // so we search for the first <t> node
        const tEl = sharedStringEl.getElementsByTagName('t')[0]

        if (tEl != null) {
          value = tEl.textContent
          valueEl = tEl
          contentEl = vEl
        }

        break
      }
      // we check for "e" because the xlsx can
      // contain formula with error
      case 'e':
      case 'str': {
        if (explicitType === 'e') {
          type = 'str'
        }

        const fEl = childEls.find((el) => el.nodeName === 'f')

        if (fEl != null) {
          value = fEl.textContent
          valueEl = fEl
          contentEl = fEl
        }

        break
      }
    }
  } else {
    // checking if the cell is inline string value
    const isEl = childEls.find((el) => el.nodeName === 'is')

    if (isEl != null) {
      const tEl = nodeListToArray(isEl.childNodes).find((el) => el.nodeName === 't')

      if (tEl != null) {
        type = 'inlineStr'
        value = tEl.textContent
        valueEl = tEl
        contentEl = isEl
      }
    }

    // now checking if the cell is formula value
    const fEl = childEls.find((el) => el.nodeName === 'f')

    if (type == null && fEl != null) {
      type = 'str'
      value = fEl.textContent
      valueEl = fEl
      contentEl = fEl
    }

    const vEl = childEls.find((el) => el.nodeName === 'v')
    const excelNumberAndDecimalRegExp = /^\d+(\.\d+)?(E-\d+)?$/

    // finally checking if the cell is number value
    if (type == null && vEl != null && excelNumberAndDecimalRegExp.test(vEl.textContent)) {
      type = 'n'
      value = vEl.textContent
      valueEl = vEl
      contentEl = vEl
    }
  }

  if (value == null) {
    throw new Error('Expected value to be found in cell')
  }

  return {
    type,
    value,
    valueEl,
    contentEl
  }
}

function findCellElInCalcChain (sheetId, cellRef, calcChainEls) {
  const foundIndex = calcChainEls.findIndex((el) => {
    return el.getAttribute('r') === cellRef && el.getAttribute('i') === sheetId
  })

  if (foundIndex === -1) {
    return
  }

  const cellEl = calcChainEls[foundIndex]

  return cellEl
}

function processOpeningTag (doc, refElement, helperCall) {
  const fakeElement = doc.createElement('xlsxRemove')
  fakeElement.textContent = helperCall
  refElement.parentNode.insertBefore(fakeElement, refElement)
}

function processClosingTag (doc, refElement, closeCall) {
  const fakeElement = doc.createElement('xlsxRemove')
  fakeElement.textContent = closeCall
  refElement.parentNode.insertBefore(fakeElement, refElement.nextSibling)
}
