import * as vscode from 'vscode';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CSV Parser — handles RFC 4180 quoted fields
// ---------------------------------------------------------------------------

interface CSVParsedData {
    headers: string[];
    rows: string[][];
    delimiter: string;
    totalRows: number;
}

function detectDelimiter(firstLine: string): string {
    const tab = (firstLine.match(/\t/g) || []).length;
    const comma = (firstLine.match(/,/g) || []).length;
    const semicolon = (firstLine.match(/;/g) || []).length;

    if (tab > comma && tab > semicolon) { return '\t'; }
    if (semicolon > comma) { return ';'; }
    return ',';
}

function parseCSVLine(line: string, delimiter: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
        const char = line[i];

        if (inQuotes) {
            if (char === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    // Escaped quote
                    current += '"';
                    i += 2;
                    continue;
                }
                // End of quoted field
                inQuotes = false;
                i++;
                continue;
            }
            current += char;
            i++;
        } else {
            if (char === '"') {
                inQuotes = true;
                i++;
                continue;
            }
            if (char === delimiter) {
                fields.push(current.trim());
                current = '';
                i++;
                continue;
            }
            current += char;
            i++;
        }
    }

    fields.push(current.trim());
    return fields;
}

function parseCSV(content: string): CSVParsedData {
    // Normalize line endings
    const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').filter(l => l.trim().length > 0);

    if (lines.length === 0) {
        return { headers: [], rows: [], delimiter: ',', totalRows: 0 };
    }

    const delimiter = detectDelimiter(lines[0]);
    const headers = parseCSVLine(lines[0], delimiter);
    const rows: string[][] = [];

    for (let i = 1; i < lines.length; i++) {
        const row = parseCSVLine(lines[i], delimiter);
        // Pad or trim to match header count
        while (row.length < headers.length) { row.push(''); }
        if (row.length > headers.length) { row.length = headers.length; }
        rows.push(row);
    }

    return { headers, rows, delimiter, totalRows: rows.length };
}

// ---------------------------------------------------------------------------
// CustomReadonlyEditorProvider
// ---------------------------------------------------------------------------

export class CSVEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {

    private static readonly viewType = 'csvViewer.tableView';

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            CSVEditorProvider.viewType,
            new CSVEditorProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ],
        };

        const fileBytes = await vscode.workspace.fs.readFile(document.uri);
        const content = Buffer.from(fileBytes).toString('utf-8');
        const csvData = parseCSV(content);
        const fileName = path.basename(document.uri.fsPath);

        webviewPanel.webview.html = this.getWebviewHtml(
            webviewPanel.webview,
            csvData,
            fileName
        );

        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'copyCell') {
                await vscode.env.clipboard.writeText(msg.text);
                vscode.window.showInformationMessage('Cell value copied to clipboard');
            } else if (msg.type === 'exportFiltered') {
                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(
                        document.uri.fsPath.replace(/\.[^.]+$/, '_filtered.csv')
                    ),
                    filters: { 'CSV Files': ['csv'] },
                });
                if (saveUri) {
                    await vscode.workspace.fs.writeFile(
                        saveUri,
                        Buffer.from(msg.csv, 'utf-8')
                    );
                    vscode.window.showInformationMessage(`Filtered data exported to ${path.basename(saveUri.fsPath)}`);
                }
            }
        });
    }

    private getWebviewHtml(
        webview: vscode.Webview,
        csvData: CSVParsedData,
        fileName: string
    ): string {
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'csv-viewer.css')
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'csv-viewer.js')
        );
        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   font-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${cssUri}" rel="stylesheet">
    <title>CSV Table Viewer</title>
</head>
<body>
    <div class="csv-viewer-container">
        <div class="csv-header">
            <div class="csv-title">
                <h2>CSV Table Viewer</h2>
                <span class="file-name">${escapeHtml(fileName)}</span>
            </div>
            <div class="csv-info">
                <span class="info-badge">${csvData.totalRows.toLocaleString()} rows</span>
                <span class="info-badge">${csvData.headers.length} columns</span>
                <span class="info-badge">Delimiter: ${csvData.delimiter === '\t' ? 'TAB' : escapeHtml(csvData.delimiter)}</span>
            </div>
        </div>
        <div class="csv-toolbar">
            <div class="search-box">
                <input type="text" id="search-input" placeholder="Search across all columns..." />
            </div>
            <div class="toolbar-controls">
                <label for="page-size">Rows per page:</label>
                <select id="page-size">
                    <option value="50">50</option>
                    <option value="100" selected>100</option>
                    <option value="200">200</option>
                    <option value="500">500</option>
                </select>
                <button class="toolbar-btn" id="btn-export-filtered" title="Export filtered data">Export</button>
            </div>
        </div>
        <div class="csv-table-wrapper">
            <table class="csv-table" id="csv-table">
                <thead id="csv-thead"></thead>
                <tbody id="csv-tbody"></tbody>
            </table>
        </div>
        <div class="csv-footer">
            <div class="pagination-info" id="pagination-info"></div>
            <div class="pagination-controls" id="pagination-controls"></div>
        </div>
    </div>
    <script nonce="${nonce}">
        window.__CSV_DATA__ = ${JSON.stringify(csvData)};
        window.__FILE_NAME__ = ${JSON.stringify(fileName)};
    </script>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
