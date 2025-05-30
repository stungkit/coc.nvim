'use strict'
import { Neovim } from '@chemzqm/neovim'
import { CodeAction, CodeActionContext, CodeActionKind, CodeActionTriggerKind, Range } from 'vscode-languageserver-types'
import commandManager from '../commands'
import diagnosticManager from '../diagnostic/manager'
import languages from '../languages'
import { createLogger } from '../logger'
import Document from '../model/document'
import { isFalsyOrEmpty } from '../util/array'
import { boolToNumber } from '../util/numbers'
import { CancellationToken, CancellationTokenSource } from '../util/protocol'
import { createTiming } from '../util/timing'
import window from '../window'
import workspace from '../workspace'
import { HandlerDelegate } from './types'
const logger = createLogger('handler-codeActions')

/**
 * Handle codeActions related methods.
 */
export default class CodeActions {
  constructor(
    private nvim: Neovim,
    private handler: HandlerDelegate
  ) {
    handler.addDisposable(commandManager.registerCommand('editor.action.organizeImport', async () => {
      let succeed = await this.organizeImport()
      if (!succeed) void window.showWarningMessage(`Organize import action not found`)
    }))
    commandManager.titles.set('editor.action.organizeImport', 'Run organize import code action, show warning when not exists')

    handler.addDisposable(commandManager.registerCommand('editor.action.executeCodeActions', async (doc: Document, range: Range | undefined, actionKinds: CodeActionKind[], timeout: number) => {
      await this.executeCodeActions(doc, range, actionKinds, timeout)
    }, this, true))
  }

  public async executeCodeActions(doc: Document, range: Range | undefined, actionKinds: CodeActionKind[], timeout: number): Promise<string[]> {
    let timing = createTiming('Execute code action', timeout)
    let applied: string[] = []
    for (const kind of actionKinds) {
      let codeActions = await this.getCodeActions(doc, range, [kind])
      let codeAction = codeActions.find(o => !o.disabled)
      if (codeAction) {
        logger.info(`Apply code action "${kind}" to buffer ${doc.bufnr}`)
        timing.start(`"${kind}"`)
        let tokenSource = new CancellationTokenSource()
        let timer: NodeJS.Timeout
        let _resolve: (value: any) => void
        const tp = new Promise<undefined>(c => {
          timer = setTimeout(() => {
            logger.warn(`Apply code action "${kind}" timeout after ${timeout}ms`)
            tokenSource.cancel()
            c(undefined)
          }, timeout)
          _resolve = c
        })
        await Promise.race([tp, this.applyCodeAction(codeAction, tokenSource.token)])
        if (!tokenSource.token.isCancellationRequested) {
          applied.push(kind)
        }
        timing.stop()
        clearTimeout(timer)
        _resolve(undefined)
        tokenSource.dispose()
        await doc.synchronize()
      }
    }
    return applied
  }

  public async codeActionRange(start: number, end: number, only?: string): Promise<void> {
    let { doc } = await this.handler.getCurrentState()
    await doc.synchronize()
    let line = doc.getline(end - 1)
    let range = Range.create(start - 1, 0, end - 1, line.length)
    let codeActions = await this.getCodeActions(doc, range, only ? [only] : null)
    codeActions = codeActions.filter(o => !o.disabled)
    if (!codeActions || codeActions.length == 0) {
      void window.showWarningMessage(`No${only ? ' ' + only : ''} code action available`)
      return
    }
    let idx = await window.showMenuPicker(codeActions.map(o => o.title), 'Choose action')
    let action = codeActions[idx]
    if (action) await this.applyCodeAction(action)
  }

  public async organizeImport(): Promise<boolean> {
    let { doc } = await this.handler.getCurrentState()
    await doc.synchronize()
    let actions = await this.getCodeActions(doc, undefined, [CodeActionKind.SourceOrganizeImports])
    if (actions && actions.length) {
      await this.applyCodeAction(actions[0])
      return true
    }
    return false
  }

  public async getCodeActions(doc: Document, range?: Range, only?: CodeActionKind[]): Promise<CodeAction[]> {
    let excludeSourceAction = range !== null && (!only || only.findIndex(o => o.startsWith(CodeActionKind.Source)) == -1)
    range = range ?? Range.create(0, 0, doc.lineCount, 0)
    let diagnostics = diagnosticManager.getDiagnosticsInRange(doc.textDocument, range)
    let context: CodeActionContext = { diagnostics, triggerKind: CodeActionTriggerKind.Invoked }
    if (!isFalsyOrEmpty(only)) context.only = only
    let tokenSource = new CancellationTokenSource()
    let codeActions = await languages.getCodeActions(doc.textDocument, range, context, tokenSource.token)
    if (!codeActions || codeActions.length == 0) return []
    if (excludeSourceAction) {
      codeActions = codeActions.filter(o => !o.kind || !o.kind.startsWith(CodeActionKind.Source))
    }
    codeActions.sort((a, b) => {
      if (a.disabled && !b.disabled) return 1
      if (b.disabled && !a.disabled) return -1
      if (a.isPreferred != b.isPreferred) return boolToNumber(b.isPreferred) - boolToNumber(a.isPreferred)
      if (!only) {
        if (isQuickfix(a) && !isQuickfix(b)) return -1
        if (isQuickfix(b) && !isQuickfix(a)) return 1
      }
      return 0
    })
    return codeActions
  }

  private get floatActions(): boolean {
    return workspace.initialConfiguration.get<boolean>('coc.preferences.floatActions', true)
  }

  public async doCodeAction(mode: string | null, only: CodeActionKind[] | string, showDisable = false): Promise<void> {
    let { doc } = await this.handler.getCurrentState()
    let range: Range | undefined
    if (mode) range = await window.getSelectedRange(mode)
    await doc.synchronize()
    let codeActions = await this.getCodeActions(doc, range, Array.isArray(only) ? only : null)
    if (typeof only == 'string') {
      codeActions = codeActions.filter(o => o.title == only || (o.command && o.command.title == only))
    } else if (Array.isArray(only)) {
      codeActions = codeActions.filter(o => only.some(k => o.kind && o.kind.startsWith(k)))
    }
    if (!this.floatActions || !showDisable) codeActions = codeActions.filter(o => !o.disabled)
    if (!codeActions || codeActions.length == 0) {
      void window.showWarningMessage(`No${only ? ' ' + only : ''} code action available`)
      return
    }
    if (codeActions.length == 1 && !codeActions[0].disabled && shouldAutoApply(only)) {
      await this.applyCodeAction(codeActions[0])
      return
    }
    let idx = this.floatActions
      ? await window.showMenuPicker(
        codeActions.map(o => {
          return { text: o.title, disabled: o.disabled }
        }),
        'Choose action'
      )
      : await window.requestInputList('Choose action by number', codeActions.map(o => o.title))
    let action = codeActions[idx]
    if (action) await this.applyCodeAction(action)
  }

  /**
   * Get current codeActions
   */
  public async getCurrentCodeActions(mode?: string, only?: CodeActionKind[]): Promise<CodeAction[]> {
    let { doc } = await this.handler.getCurrentState()
    let range: Range
    if (mode) range = await window.getSelectedRange(mode)
    let codeActions = await this.getCodeActions(doc, range, only)
    return codeActions.filter(o => !o.disabled)
  }

  /**
   * Invoke preferred quickfix at current position
   */
  public async doQuickfix(): Promise<void> {
    let actions = await this.getCurrentCodeActions('currline', [CodeActionKind.QuickFix])
    if (!actions || actions.length == 0) {
      void window.showWarningMessage(`No quickfix action available`)
      return
    }
    await this.applyCodeAction(actions[0])
    this.nvim.command(`silent! call repeat#set("\\<Plug>(coc-fix-current)", -1)`, true)
  }

  public async applyCodeAction(action: CodeAction, token?: CancellationToken): Promise<void> {
    if (action.disabled) {
      throw new Error(`Action "${action.title}" is disabled: ${action.disabled.reason}`)
    }
    token = token == null ? CancellationToken.None : token
    let resolved = await languages.resolveCodeAction(action, token)
    if (!resolved || token.isCancellationRequested) return
    let { edit, command } = resolved
    if (edit) await workspace.applyEdit(edit)
    if (command) await commandManager.execute(command)
  }
}

export function shouldAutoApply(only: CodeActionKind[] | string | undefined): boolean {
  if (!only) return false
  if (typeof only === 'string' || only[0] === CodeActionKind.QuickFix || only[0] === CodeActionKind.SourceFixAll) {
    return workspace.initialConfiguration.get('coc.preferences.autoApplySingleQuickfix', true)
  }
  return false
}

function isQuickfix(codeAction: CodeAction): boolean {
  return codeAction.kind && codeAction.kind.startsWith('quickfix')
}
