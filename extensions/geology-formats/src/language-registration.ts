import * as vscode from 'vscode';

/**
 * Register geological file format languages with basic configuration.
 *
 * Language IDs and file associations are declared in package.json `contributes.languages`.
 * This module adds language configuration (comments, brackets, etc.) at runtime.
 *
 * Note: Monarch tokenizers from the Theia version cannot be used directly in VS Code.
 * VS Code uses TextMate grammars for syntax highlighting. For now we register language
 * configs only — syntax highlighting can be added later via .tmLanguage.json files
 * in the `syntaxes/` directory if needed.
 */
export function registerGeologicalLanguages(context: vscode.ExtensionContext): void {
    // LAS — Log ASCII Standard
    context.subscriptions.push(
        vscode.languages.setLanguageConfiguration('las', {
            comments: { lineComment: '#' },
            brackets: [],
            autoClosingPairs: [
                { open: '"', close: '"' },
                { open: "'", close: "'" },
            ],
        })
    );

    // WLEF — Well Log Exchange Format (JSON-based)
    context.subscriptions.push(
        vscode.languages.setLanguageConfiguration('wlef', {
            comments: {
                lineComment: '//',
                blockComment: ['/*', '*/'],
            },
            brackets: [
                ['{', '}'],
                ['[', ']'],
            ],
            autoClosingPairs: [
                { open: '{', close: '}' },
                { open: '[', close: ']' },
                { open: '"', close: '"' },
            ],
        })
    );

    // Petrel project files
    context.subscriptions.push(
        vscode.languages.setLanguageConfiguration('petrel', {
            comments: {
                lineComment: '//',
                blockComment: ['<!--', '-->'],
            },
            brackets: [
                ['{', '}'],
                ['[', ']'],
                ['(', ')'],
                ['<', '>'],
            ],
            autoClosingPairs: [
                { open: '{', close: '}' },
                { open: '[', close: ']' },
                { open: '(', close: ')' },
                { open: '"', close: '"' },
                { open: "'", close: "'" },
                { open: '<', close: '>' },
            ],
        })
    );

    // SEG-Y and DLIS are binary formats — no language config needed beyond
    // the file association in package.json. VS Code will show them as plain
    // text (which is fine — the text headers are human-readable).
}
