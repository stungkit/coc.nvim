'use strict'
import { Neovim } from '@chemzqm/neovim'
import { DocumentHighlight, DocumentHighlightKind, Position, Range } from 'vscode-languageserver-types'
import commands from '../commands'
import events from '../events'
import languages, { ProviderName } from '../languages'
import Document from '../model/document'
import { IConfigurationChangeEvent } from '../types'
import { disposeAll } from '../util'
import { comparePosition, compareRangesUsingStarts } from '../util/position'
import { CancellationTokenSource, Disposable } from '../util/protocol'
import window from '../window'
import workspace from '../workspace'
import { HandlerDelegate } from './types'

interface HighlightConfig {
  limit: number
  priority: number
  timeout: number
}

/**
 * Highlight same symbols on current window.
 * Highlights are added to window by matchaddpos.
 */
export default class Highlights {
  private config: HighlightConfig
  private disposables: Disposable[] = []
  private tokenSource: CancellationTokenSource
  private highlights: Map<number, DocumentHighlight[]> = new Map()
  private timer: NodeJS.Timeout
  constructor(private nvim: Neovim, private handler: HandlerDelegate) {
    events.on(['CursorMoved', 'CursorMovedI'], () => {
      this.cancel()
      this.clearHighlights()
    }, null, this.disposables)
    this.loadConfiguration()
    workspace.onDidChangeConfiguration(this.loadConfiguration, this, this.disposables)
    window.onDidChangeActiveTextEditor(() => {
      this.loadConfiguration()
    }, null, this.disposables)
    commands.register({
      id: 'document.jumpToNextSymbol',
      execute: async () => {
        await this.jumpSymbol('next')
      }
    }, false, 'Jump to next symbol highlight position.')
    commands.register({
      id: 'document.jumpToPrevSymbol',
      execute: async () => {
        await this.jumpSymbol('previous')
      }
    }, false, 'Jump to previous symbol highlight position.')
  }

  private loadConfiguration(e?: IConfigurationChangeEvent): void {
    let config = workspace.getConfiguration('documentHighlight', this.handler.uri)
    if (!e || e.affectsConfiguration('documentHighlight')) {
      this.config = Object.assign(this.config || {}, {
        limit: config.get<number>('limit', 200),
        priority: config.get<number>('priority', -1),
        timeout: config.get<number>('timeout', 300)
      })
    }
  }

  public isEnabled(bufnr: number, cursors: number): boolean {
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.attached || cursors) return false
    if (!languages.hasProvider(ProviderName.DocumentHighlight, doc.textDocument)) return false
    return true
  }

  public clearHighlights(): void {
    if (this.highlights.size == 0) return
    for (let winid of this.highlights.keys()) {
      let win = this.nvim.createWindow(winid)
      win.clearMatchGroup('^CocHighlight')
    }
    this.highlights.clear()
  }

  public async highlight(): Promise<void> {
    let { nvim } = this
    this.cancel()
    let [bufnr, winid, pos, cursors] = await nvim.eval(`[bufnr("%"),win_getid(),coc#cursor#position(),get(b:,'coc_cursors_activated',0)]`) as [number, number, [number, number], number]
    if (!this.isEnabled(bufnr, cursors)) return
    let doc = workspace.getDocument(bufnr)
    let highlights = await this.getHighlights(doc, Position.create(pos[0], pos[1]))
    if (!highlights) return
    let groups: { [index: string]: Range[] } = {}
    for (let hl of highlights) {
      if (!Range.is(hl.range)) continue
      let hlGroup = hl.kind == DocumentHighlightKind.Text
        ? 'CocHighlightText'
        : hl.kind == DocumentHighlightKind.Read ? 'CocHighlightRead' : 'CocHighlightWrite'
      groups[hlGroup] = groups[hlGroup] || []
      groups[hlGroup].push(hl.range)
    }
    let win = nvim.createWindow(winid)
    nvim.pauseNotification()
    win.clearMatchGroup('^CocHighlight')
    for (let [hlGroup, ranges] of Object.entries(groups)) {
      win.highlightRanges(hlGroup, ranges, -1, true)
    }
    nvim.resumeNotification(true, true)
    this.highlights.set(winid, highlights)
  }

  public async jumpSymbol(direction: 'previous' | 'next'): Promise<void> {
    let ranges = await this.getSymbolsRanges()
    if (!ranges) return
    let pos = await window.getCursorPosition()
    if (direction == 'next') {
      for (let i = 0; i <= ranges.length - 1; i++) {
        if (comparePosition(ranges[i].start, pos) > 0) {
          await window.moveTo(ranges[i].start)
          return
        }
      }
      await window.moveTo(ranges[0].start)
    } else {
      for (let i = ranges.length - 1; i >= 0; i--) {
        if (comparePosition(ranges[i].end, pos) < 0) {
          await window.moveTo(ranges[i].start)
          return
        }
      }
      await window.moveTo(ranges[ranges.length - 1].start)
    }
  }

  public async getSymbolsRanges(): Promise<Range[]> {
    let { doc, position } = await this.handler.getCurrentState()
    this.handler.checkProvider(ProviderName.DocumentHighlight, doc.textDocument)
    let highlights = await this.getHighlights(doc, position)
    if (!highlights) return null
    return highlights.filter(o => Range.is(o.range)).map(o => o.range).sort((a, b) => {
      return compareRangesUsingStarts(a, b)
    })
  }

  public hasHighlights(winid: number): boolean {
    return this.highlights.get(winid) != null
  }

  public async getHighlights(doc: Document, position: Position): Promise<DocumentHighlight[]> {
    let line = doc.getline(position.line)
    let ch = line[position.character]
    if (!ch || !doc.isWord(ch)) return null
    await doc.synchronize()
    this.cancel()
    let source = this.tokenSource = new CancellationTokenSource()
    let timer = this.timer = setTimeout(() => {
      source.cancel()
    }, this.config.timeout)
    let highlights = await languages.getDocumentHighLight(doc.textDocument, position, source.token)
    clearTimeout(timer)
    if (source.token.isCancellationRequested) return null
    return highlights
  }

  private cancel(): void {
    if (this.tokenSource) {
      this.tokenSource.cancel()
      this.tokenSource.dispose()
      this.tokenSource = null
    }
  }

  public dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.cancel()
    this.highlights.clear()
    disposeAll(this.disposables)
  }
}
