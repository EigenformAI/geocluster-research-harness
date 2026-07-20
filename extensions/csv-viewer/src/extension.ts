import * as vscode from 'vscode';
import { CSVEditorProvider } from './csv-editor-provider';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        CSVEditorProvider.register(context)
    );
}

export function deactivate(): void {
    // nothing to clean up
}
