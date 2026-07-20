/**
 * LAS Viewer Webview Script
 *
 * Runs inside the VS Code Webview sandbox. Communicates with the extension
 * host via acquireVsCodeApi().postMessage() for operations that need
 * file system access (CSV export, clipboard).
 *
 * Expects window.__LAS_DATA__ and window.__FILE_NAME__ to be set before load.
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const lasData = window.__LAS_DATA__;
    const fileName = window.__FILE_NAME__;

    let currentPage = 1;
    let rowsPerPage = 100;

    // -----------------------------------------------------------------------
    // Tab switching
    // -----------------------------------------------------------------------
    document.querySelectorAll('.las-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.las-tab').forEach(function (t) {
                t.classList.remove('active');
            });
            document.querySelectorAll('.tab-panel').forEach(function (p) {
                p.classList.remove('active');
            });
            tab.classList.add('active');
            var panelId = tab.getAttribute('data-tab') + '-panel';
            var panel = document.getElementById(panelId);
            if (panel) { panel.classList.add('active'); }
        });
    });

    // -----------------------------------------------------------------------
    // Quick actions (overview panel)
    // -----------------------------------------------------------------------
    var btnExportCsv = document.getElementById('btn-export-csv');
    if (btnExportCsv) {
        btnExportCsv.addEventListener('click', function () { exportCsv(); });
    }

    var btnCopySummary = document.getElementById('btn-copy-summary');
    if (btnCopySummary) {
        btnCopySummary.addEventListener('click', function () { copySummary(); });
    }

    var btnShowStats = document.getElementById('btn-show-stats');
    if (btnShowStats) {
        btnShowStats.addEventListener('click', function () { showStatistics(); });
    }

    // -----------------------------------------------------------------------
    // Data table — rendered client-side for pagination
    // -----------------------------------------------------------------------
    renderDataPanel();

    function renderDataPanel() {
        var root = document.getElementById('data-panel-root');
        if (!root) { return; }

        var headers = lasData.curveInfo.map(function (c) { return c.mnemonic; });
        var totalRows = lasData.data.length;
        var totalPages = Math.ceil(totalRows / rowsPerPage) || 1;
        var startIdx = (currentPage - 1) * rowsPerPage;
        var endIdx = Math.min(startIdx + rowsPerPage, totalRows);
        var pageData = lasData.data.slice(startIdx, endIdx);

        var headerCells = headers.map(function (h) {
            return '<th>' + escapeHtml(h) + '</th>';
        }).join('');

        var dataRows = pageData.map(function (row) {
            var cells = row.map(function (val) {
                var isNull = val === lasData.nullValue;
                return '<td class="' + (isNull ? 'null-value' : '') + '">' +
                    (isNull ? 'NULL' : val.toFixed(3)) + '</td>';
            }).join('');
            return '<tr>' + cells + '</tr>';
        }).join('');

        root.innerHTML =
            '<div class="data-table-container">' +
                '<div class="data-controls">' +
                    '<label>Rows per page:</label>' +
                    '<select id="rows-per-page">' +
                        '<option value="50"' + (rowsPerPage === 50 ? ' selected' : '') + '>50</option>' +
                        '<option value="100"' + (rowsPerPage === 100 ? ' selected' : '') + '>100</option>' +
                        '<option value="200"' + (rowsPerPage === 200 ? ' selected' : '') + '>200</option>' +
                    '</select>' +
                    '<button class="export-btn" id="btn-export-data">Export</button>' +
                    '<span class="data-info">' +
                        (totalRows > 0 ? (startIdx + 1) + '-' + endIdx + ' of ' + totalRows : 'No data') +
                    '</span>' +
                '</div>' +
                '<div class="scrollable-table">' +
                    '<table class="las-data-table">' +
                        '<thead><tr>' + headerCells + '</tr></thead>' +
                        '<tbody>' + (dataRows || '<tr><td colspan="' + headers.length + '">No data</td></tr>') + '</tbody>' +
                    '</table>' +
                '</div>' +
                '<div class="data-pagination">' +
                    '<button class="nav-btn" id="btn-prev"' + (currentPage <= 1 ? ' disabled' : '') + '>Previous</button>' +
                    '<span>Page ' + currentPage + ' of ' + totalPages + '</span>' +
                    '<button class="nav-btn" id="btn-next"' + (currentPage >= totalPages ? ' disabled' : '') + '>Next</button>' +
                '</div>' +
            '</div>';

        // Attach data panel event handlers
        var btnPrev = document.getElementById('btn-prev');
        if (btnPrev) {
            btnPrev.addEventListener('click', function () {
                if (currentPage > 1) { currentPage--; renderDataPanel(); }
            });
        }

        var btnNext = document.getElementById('btn-next');
        if (btnNext) {
            btnNext.addEventListener('click', function () {
                var tp = Math.ceil(lasData.data.length / rowsPerPage);
                if (currentPage < tp) { currentPage++; renderDataPanel(); }
            });
        }

        var rppSelect = document.getElementById('rows-per-page');
        if (rppSelect) {
            rppSelect.addEventListener('change', function (e) {
                rowsPerPage = parseInt(e.target.value, 10);
                currentPage = 1;
                renderDataPanel();
            });
        }

        var btnExportData = document.getElementById('btn-export-data');
        if (btnExportData) {
            btnExportData.addEventListener('click', function () { exportCsv(); });
        }
    }

    // -----------------------------------------------------------------------
    // Plot generation
    // -----------------------------------------------------------------------
    var btnPlot = document.getElementById('btn-generate-plot');
    if (btnPlot) {
        btnPlot.addEventListener('click', function () { generatePlot(); });
    }

    function generatePlot() {
        var select = document.getElementById('curve-selector');
        var plotArea = document.getElementById('las-plot');
        if (!select || !plotArea || !lasData) { return; }

        var curveName = select.value;
        var curveIdx = -1;
        for (var i = 0; i < lasData.curveInfo.length; i++) {
            if (lasData.curveInfo[i].mnemonic === curveName) { curveIdx = i; break; }
        }
        if (curveIdx === -1) { return; }

        var vals = [];
        for (var j = 0; j < lasData.data.length; j++) {
            var v = lasData.data[j][curveIdx];
            if (v !== lasData.nullValue) { vals.push(v); }
        }

        if (vals.length === 0) {
            plotArea.innerHTML = '<div class="plot-placeholder"><p>No valid data for this curve</p></div>';
            return;
        }

        var min = vals[0], max = vals[0];
        for (var k = 0; k < vals.length; k++) {
            if (vals[k] < min) { min = vals[k]; }
            if (vals[k] > max) { max = vals[k]; }
        }
        var range = max - min || 1;

        var step = Math.ceil(vals.length / 200);
        var bars = '';
        for (var s = 0; s < vals.length; s += step) {
            var h = ((vals[s] - min) / range) * 250;
            bars += '<div class="chart-bar" style="height:' + h + 'px"></div>';
        }

        plotArea.innerHTML =
            '<div class="simple-chart">' +
                '<div class="chart-title">' + escapeHtml(curveName) + '</div>' +
                '<div class="chart-stats">Min: ' + min.toFixed(2) + ' | Max: ' + max.toFixed(2) + '</div>' +
                '<div class="chart-container" style="height:260px">' + bars + '</div>' +
            '</div>';
    }

    // -----------------------------------------------------------------------
    // CSV export — sends data to extension host for file save dialog
    // -----------------------------------------------------------------------
    function exportCsv() {
        var headers = lasData.curveInfo.map(function (c) { return c.mnemonic; });
        var csv = headers.join(',') + '\n';
        for (var i = 0; i < lasData.data.length; i++) {
            csv += lasData.data[i].join(',') + '\n';
        }
        vscode.postMessage({ type: 'exportCsv', csv: csv });
    }

    // -----------------------------------------------------------------------
    // Copy summary — sends text to extension host for clipboard
    // -----------------------------------------------------------------------
    function copySummary() {
        var well = null;
        for (var i = 0; i < lasData.wellInfo.length; i++) {
            if (lasData.wellInfo[i].mnemonic === 'WELL') { well = lasData.wellInfo[i]; break; }
        }
        var curves = lasData.curveInfo.map(function (c) { return c.mnemonic; }).join(', ');
        var text = 'File: ' + fileName +
            '\nWell: ' + (well ? well.value : 'Unknown') +
            '\nCurves: ' + curves +
            '\nData Points: ' + lasData.data.length;
        vscode.postMessage({ type: 'copySummary', text: text });
    }

    // -----------------------------------------------------------------------
    // Statistics — sends formatted text to extension host for modal dialog
    // -----------------------------------------------------------------------
    function showStatistics() {
        if (!lasData.data.length) {
            vscode.postMessage({ type: 'showStats', text: 'No data available for statistics.' });
            return;
        }
        var lines = [];
        for (var i = 0; i < lasData.curveInfo.length; i++) {
            var curve = lasData.curveInfo[i];
            var vals = [];
            for (var j = 0; j < lasData.data.length; j++) {
                var v = lasData.data[j][i];
                if (v !== lasData.nullValue && !isNaN(v)) { vals.push(v); }
            }
            if (vals.length === 0) {
                lines.push(curve.mnemonic + ': No valid data');
            } else {
                var min = vals[0], max = vals[0], sum = 0;
                for (var k = 0; k < vals.length; k++) {
                    if (vals[k] < min) { min = vals[k]; }
                    if (vals[k] > max) { max = vals[k]; }
                    sum += vals[k];
                }
                var avg = sum / vals.length;
                lines.push(curve.mnemonic + ': Min=' + min.toFixed(2) +
                    ', Max=' + max.toFixed(2) + ', Avg=' + avg.toFixed(2));
            }
        }
        vscode.postMessage({ type: 'showStats', text: 'Statistics:\n\n' + lines.join('\n') });
    }

    // -----------------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------------
    function escapeHtml(str) {
        if (!str) { return ''; }
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
})();
