// Global test runtime for the nvim lane. preload.cjs (scripts/test) bundles
// scripts/test/editor-session.mjs into bundle.js and exposes these on
// globalThis, so test files do not import anything from src/__tests__ for
// the editor session/suite.
import type { Disposable } from 'vscode-languageserver-protocol'

declare global {
  class EditorSession {
    proc: any
    plugin: any
    readonly nvim: any
    readonly workspace: any
    readonly completion: any
    start(kind?: 'nvim' | 'vim'): Promise<void>
    reset(): Promise<void>
    stop(): Promise<void>
    wait(ms?: number): Promise<void>
    waitValue<T>(fn: () => T | Promise<T>, value: T): Promise<void>
    waitFor<T>(method: string, args: any[], value: T): Promise<void>
    waitNotification(event: string): Promise<void>
    waitPrompt(): Promise<void>
    waitPromptWin(): Promise<number>
    waitFloat(): Promise<number>
    waitPopup(): Promise<void>
    doAction(method: string, ...args: any[]): Promise<any>
    items(): Promise<any[]>
    confirmCompletion(idx: number): Promise<void>
    visible(word: string, source?: string): Promise<boolean>
    edit(file?: string): Promise<any>
    createDocument(name?: string): Promise<any>
    listInput(input: string): Promise<void>
    getCmdline(lnum?: number): Promise<string>
    updateConfiguration(key: string, value: any, disposables?: Disposable[]): () => void
    getMatches(hlGroup: string): Promise<any[]>
    mockFunction(name: string, result: string | number | any): Promise<void>
    getFloat(kind?: string): Promise<any>
    getWinLines(winid: number): Promise<string[]>
    createNullChannel(): any
  }

  function editorSuite(name: string, fn: () => void): void
  function getSession(): EditorSession
  function setSession(session: EditorSession): void
  function createTmpFile(content: string, disposables?: Disposable[]): Promise<string>
}

export {}
