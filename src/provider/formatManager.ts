'use strict'
import { v4 as uuid } from 'uuid'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { FormattingOptions, TextEdit } from 'vscode-languageserver-types'
import { CancellationToken, Disposable } from '../util/protocol'
import { DocumentFormattingEditProvider, DocumentSelector } from './index'
import Manager from './manager'

export default class FormatManager extends Manager<DocumentFormattingEditProvider> {

  public register(selector: DocumentSelector, provider: DocumentFormattingEditProvider, priority: number): Disposable {
    return this.addProvider({
      id: uuid(),
      selector,
      priority,
      provider
    })
  }

  public async provideDocumentFormattingEdits(
    document: TextDocument,
    options: FormattingOptions,
    token: CancellationToken
  ): Promise<TextEdit[]> {
    let item = this.getFormatProvider(document)
    if (!item) return null
    let { provider } = item
    let res = await Promise.resolve(provider.provideDocumentFormattingEdits(document, options, token))
    if (Array.isArray(res)) {
      Object.defineProperty(res, '__extensionName', {
        get: () => item.provider['__extensionName']
      })
    }
    return res
  }
}
