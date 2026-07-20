import * as vscode from 'vscode';
import { LASEditorProvider } from './las-editor-provider';
import { registerGeologicalLanguages } from './language-registration';

export function activate(context: vscode.ExtensionContext): void {
    // Register the LAS custom editor
    context.subscriptions.push(
        LASEditorProvider.register(context)
    );

    // Register syntax highlighting for geological formats
    registerGeologicalLanguages(context);
}

export function deactivate(): void {
    // nothing to clean up
}
