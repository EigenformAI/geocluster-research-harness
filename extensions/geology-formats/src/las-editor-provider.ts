import * as vscode from 'vscode';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Data types — verbatim from Theia las-file-viewer.ts
// ---------------------------------------------------------------------------

interface LASWellInfo {
    mnemonic: string;
    unit: string;
    value: string;
    description: string;
}

interface LASCurveInfo {
    mnemonic: string;
    unit: string;
    description: string;
    apiCode?: string;
}

interface LASParsedData {
    version: string;
    wrap: string;
    wellInfo: LASWellInfo[];
    curveInfo: LASCurveInfo[];
    parameters: LASWellInfo[];
    data: number[][];
    nullValue: number;
}

// ---------------------------------------------------------------------------
// LAS Parser — verbatim from Theia las-file-viewer.ts (lines 115-217)
// ---------------------------------------------------------------------------

function parseLASFile(content: string): LASParsedData {
    const lines = content.split('\n');
    const data: LASParsedData = {
        version: '2.0',
        wrap: 'NO',
        wellInfo: [],
        curveInfo: [],
        parameters: [],
        data: [],
        nullValue: -999.25,
    };

    let currentSection = '';
    let inAsciiSection = false;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) { continue; }

        if (trimmedLine.startsWith('~')) {
            const sectionChar = trimmedLine.charAt(1).toUpperCase();
            if (sectionChar === 'V') { currentSection = 'VERSION'; }
            else if (sectionChar === 'W') { currentSection = 'WELL'; }
            else if (sectionChar === 'C') { currentSection = 'CURVE'; }
            else if (sectionChar === 'P') { currentSection = 'PARAMETER'; }
            else if (sectionChar === 'A') {
                currentSection = 'ASCII';
                inAsciiSection = true;
            }
            continue;
        }

        if (currentSection === 'VERSION') {
            if (trimmedLine.includes('VERS')) {
                const match = trimmedLine.match(/(\d+\.?\d*)/);
                if (match) { data.version = match[1]; }
            } else if (trimmedLine.includes('WRAP')) {
                data.wrap = trimmedLine.includes('YES') ? 'YES' : 'NO';
            }
        } else if (currentSection === 'WELL') {
            const info = parseInfoLine(trimmedLine);
            if (info) {
                data.wellInfo.push(info);
                if (info.mnemonic === 'NULL') {
                    data.nullValue = parseFloat(info.value) || -999.25;
                }
            }
        } else if (currentSection === 'CURVE') {
            const curve = parseCurveLine(trimmedLine);
            if (curve) { data.curveInfo.push(curve); }
        } else if (currentSection === 'PARAMETER') {
            const param = parseInfoLine(trimmedLine);
            if (param) { data.parameters.push(param); }
        } else if (inAsciiSection) {
            const values = trimmedLine.split(/\s+/).map(v => parseFloat(v)).filter(v => !isNaN(v));
            if (values.length > 0) { data.data.push(values); }
        }
    }

    return data;
}

function parseInfoLine(line: string): LASWellInfo | null {
    // Format: MNEMONIC .UNIT VALUE : DESCRIPTION
    const match = line.match(/^\s*(\w+)\s*\.(\S*)\s+(.*?)\s*:\s*(.*)$/);
    if (match) {
        return {
            mnemonic: match[1].trim(),
            unit: match[2].trim() || '',
            value: match[3].trim(),
            description: match[4].trim(),
        };
    }
    // Alternative format without colon
    const altMatch = line.match(/^\s*(\w+)\s*\.(\S*)\s+(.+)$/);
    if (altMatch) {
        return {
            mnemonic: altMatch[1].trim(),
            unit: altMatch[2].trim() || '',
            value: altMatch[3].trim(),
            description: '',
        };
    }
    return null;
}

function parseCurveLine(line: string): LASCurveInfo | null {
    const match = line.match(/^\s*(\w+)\s*\.(\S*)\s+(.*?)\s*:\s*(.*)$/);
    if (match) {
        return {
            mnemonic: match[1].trim(),
            unit: match[2].trim() || '',
            apiCode: match[3].trim(),
            description: match[4].trim(),
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// CustomReadonlyEditorProvider
// ---------------------------------------------------------------------------

export class LASEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {

    private static readonly viewType = 'geology.lasViewer';

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            LASEditorProvider.viewType,
            new LASEditorProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    // --- CustomReadonlyEditorProvider implementation ---

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

        // Read and parse the LAS file
        const fileBytes = await vscode.workspace.fs.readFile(document.uri);
        const content = Buffer.from(fileBytes).toString('utf-8');
        const lasData = parseLASFile(content);
        const fileName = path.basename(document.uri.fsPath);

        // Build Webview HTML
        webviewPanel.webview.html = this.getWebviewHtml(
            webviewPanel.webview,
            lasData,
            fileName
        );

        // Handle messages from Webview (CSV export)
        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'exportCsv') {
                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(
                        document.uri.fsPath.replace(/\.las$/i, '.csv')
                    ),
                    filters: { 'CSV Files': ['csv'] },
                });
                if (saveUri) {
                    await vscode.workspace.fs.writeFile(
                        saveUri,
                        Buffer.from(msg.csv, 'utf-8')
                    );
                    vscode.window.showInformationMessage(`CSV exported to ${path.basename(saveUri.fsPath)}`);
                }
            } else if (msg.type === 'copySummary') {
                await vscode.env.clipboard.writeText(msg.text);
                vscode.window.showInformationMessage('Summary copied to clipboard');
            } else if (msg.type === 'showStats') {
                vscode.window.showInformationMessage(msg.text, { modal: true });
            }
        });
    }

    // --- HTML generation ---

    private getWebviewHtml(
        webview: vscode.Webview,
        lasData: LASParsedData,
        fileName: string
    ): string {
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'las-viewer.css')
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'las-viewer.js')
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
    <title>LAS File Viewer</title>
</head>
<body>
    <div class="las-viewer-container">
        <div class="las-header">
            <h2>LAS File Viewer</h2>
            <div class="las-file-info">
                <span class="file-name">${escapeHtml(fileName)}</span>
            </div>
        </div>
        <div class="las-content">
            <div class="las-tabs">
                <button class="las-tab active" data-tab="overview">Overview</button>
                <button class="las-tab" data-tab="well-info">Well Information</button>
                <button class="las-tab" data-tab="curves">Curve Information</button>
                <button class="las-tab" data-tab="parameters">Parameters</button>
                <button class="las-tab" data-tab="data">Log Data</button>
                <button class="las-tab" data-tab="plot">Quick Plot</button>
            </div>
            <div class="las-tab-content">
                <div class="tab-panel active" id="overview-panel">
                    ${this.renderOverview(lasData, fileName)}
                </div>
                <div class="tab-panel" id="well-info-panel">
                    ${this.renderInfoTable(lasData.wellInfo)}
                </div>
                <div class="tab-panel" id="curves-panel">
                    ${this.renderCurveTable(lasData.curveInfo)}
                </div>
                <div class="tab-panel" id="parameters-panel">
                    ${lasData.parameters.length > 0
                        ? this.renderInfoTable(lasData.parameters)
                        : '<p>No parameters defined in this file.</p>'}
                </div>
                <div class="tab-panel" id="data-panel">
                    <div id="data-panel-root"></div>
                </div>
                <div class="tab-panel" id="plot-panel">
                    ${this.renderPlotArea(lasData)}
                </div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">
        window.__LAS_DATA__ = ${JSON.stringify(lasData)};
        window.__FILE_NAME__ = ${JSON.stringify(fileName)};
    </script>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }

    private renderOverview(lasData: LASParsedData, fileName: string): string {
        const strt = lasData.wellInfo.find(w => w.mnemonic === 'STRT');
        const stop = lasData.wellInfo.find(w => w.mnemonic === 'STOP');
        const step = lasData.wellInfo.find(w => w.mnemonic === 'STEP');
        const well = lasData.wellInfo.find(w => w.mnemonic === 'WELL');

        return `
            <div class="overview-content">
                <div class="overview-card">
                    <h3>File Summary</h3>
                    <div class="summary-grid">
                        <div class="summary-item"><label>LAS Version:</label><span>${escapeHtml(lasData.version)}</span></div>
                        <div class="summary-item"><label>Well Name:</label><span>${escapeHtml(well?.value || 'Unknown')}</span></div>
                        <div class="summary-item"><label>Number of Curves:</label><span>${lasData.curveInfo.length}</span></div>
                        <div class="summary-item"><label>Depth Range:</label><span>${escapeHtml(strt?.value || 'N/A')} - ${escapeHtml(stop?.value || 'N/A')} ${escapeHtml(strt?.unit || 'FT')}</span></div>
                        <div class="summary-item"><label>Step:</label><span>${escapeHtml(step?.value || 'N/A')} ${escapeHtml(step?.unit || 'FT')}</span></div>
                        <div class="summary-item"><label>Data Points:</label><span>${lasData.data.length}</span></div>
                    </div>
                </div>
                <div class="overview-card">
                    <h3>Quick Actions</h3>
                    <div class="quick-actions">
                        <button class="action-button" id="btn-export-csv">Export to CSV</button>
                        <button class="action-button" id="btn-copy-summary">Copy Summary</button>
                        <button class="action-button" id="btn-show-stats">Show Statistics</button>
                    </div>
                </div>
            </div>`;
    }

    private renderInfoTable(items: LASWellInfo[]): string {
        const rows = items.map(info =>
            `<tr><td>${escapeHtml(info.mnemonic)}</td><td>${escapeHtml(info.unit)}</td><td>${escapeHtml(info.value)}</td><td>${escapeHtml(info.description)}</td></tr>`
        ).join('');
        return `<div class="info-table-container">
            <table class="las-info-table">
                <thead><tr><th>Mnemonic</th><th>Unit</th><th>Value</th><th>Description</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    private renderCurveTable(curves: LASCurveInfo[]): string {
        const rows = curves.map(c =>
            `<tr><td>${escapeHtml(c.mnemonic)}</td><td>${escapeHtml(c.unit)}</td><td>${escapeHtml(c.apiCode || '')}</td><td>${escapeHtml(c.description)}</td></tr>`
        ).join('');
        return `<div class="info-table-container">
            <table class="las-info-table">
                <thead><tr><th>Mnemonic</th><th>Unit</th><th>API Code</th><th>Description</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    private renderPlotArea(lasData: LASParsedData): string {
        const curveOptions = lasData.curveInfo
            .filter(c => c.mnemonic !== 'DEPT')
            .map(c => `<option value="${escapeHtml(c.mnemonic)}">${escapeHtml(c.mnemonic)}</option>`)
            .join('');
        return `
            <div class="plot-container">
                <div class="plot-controls">
                    <div class="control-group">
                        <label>Curve:</label>
                        <select id="curve-selector">${curveOptions}</select>
                    </div>
                    <button class="plot-btn" id="btn-generate-plot">Generate Plot</button>
                </div>
                <div class="plot-area" id="las-plot">
                    <div class="plot-placeholder">
                        <p>Select a curve and click Generate Plot</p>
                    </div>
                </div>
            </div>`;
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
