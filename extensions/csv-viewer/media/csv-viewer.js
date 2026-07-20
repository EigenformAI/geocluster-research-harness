// CSV Table Viewer — webview script
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();
    const csvData = window.__CSV_DATA__;

    if (!csvData || !csvData.headers || csvData.headers.length === 0) {
        document.querySelector('.csv-table-wrapper').innerHTML =
            '<div class="csv-empty">No data found in this file.</div>';
        return;
    }

    // State
    let currentPage = 1;
    let pageSize = 100;
    let sortCol = -1;
    let sortAsc = true;
    let searchTerm = '';
    let filteredRows = csvData.rows.slice();

    const thead = document.getElementById('csv-thead');
    const tbody = document.getElementById('csv-tbody');
    const pagInfo = document.getElementById('pagination-info');
    const pagControls = document.getElementById('pagination-controls');
    const searchInput = document.getElementById('search-input');
    const pageSizeSelect = document.getElementById('page-size');
    const exportBtn = document.getElementById('btn-export-filtered');

    // Build header
    function renderHeader() {
        let html = '<tr><th class="row-num">#</th>';
        for (let i = 0; i < csvData.headers.length; i++) {
            const header = escapeHtml(csvData.headers[i]);
            let sortIndicator = '<span class="sort-indicator">\u2195</span>';
            if (sortCol === i) {
                sortIndicator = sortAsc
                    ? '<span class="sort-indicator active">\u25B2</span>'
                    : '<span class="sort-indicator active">\u25BC</span>';
            }
            html += '<th data-col="' + i + '">' + header + sortIndicator + '</th>';
        }
        html += '</tr>';
        thead.innerHTML = html;

        // Attach sort handlers
        thead.querySelectorAll('th[data-col]').forEach(function (th) {
            th.addEventListener('click', function () {
                const col = parseInt(th.getAttribute('data-col'), 10);
                if (sortCol === col) {
                    sortAsc = !sortAsc;
                } else {
                    sortCol = col;
                    sortAsc = true;
                }
                applySort();
                currentPage = 1;
                renderHeader();
                renderPage();
            });
        });
    }

    // Filter rows
    function applyFilter() {
        if (!searchTerm) {
            filteredRows = csvData.rows.slice();
        } else {
            const term = searchTerm.toLowerCase();
            filteredRows = csvData.rows.filter(function (row) {
                return row.some(function (cell) {
                    return cell.toLowerCase().indexOf(term) !== -1;
                });
            });
        }
        applySort();
        currentPage = 1;
    }

    // Sort filtered rows
    function applySort() {
        if (sortCol < 0) { return; }
        var col = sortCol;
        var asc = sortAsc;
        filteredRows.sort(function (a, b) {
            var va = a[col] || '';
            var vb = b[col] || '';
            // Try numeric comparison
            var na = parseFloat(va);
            var nb = parseFloat(vb);
            if (!isNaN(na) && !isNaN(nb)) {
                return asc ? na - nb : nb - na;
            }
            // String comparison
            var cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
            return asc ? cmp : -cmp;
        });
    }

    // Render current page
    function renderPage() {
        var totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
        if (currentPage > totalPages) { currentPage = totalPages; }

        var start = (currentPage - 1) * pageSize;
        var end = Math.min(start + pageSize, filteredRows.length);
        var pageRows = filteredRows.slice(start, end);

        var html = '';
        for (var r = 0; r < pageRows.length; r++) {
            html += '<tr>';
            html += '<td class="row-num">' + (start + r + 1) + '</td>';
            for (var c = 0; c < csvData.headers.length; c++) {
                var cell = escapeHtml(pageRows[r][c] || '');
                if (searchTerm) {
                    cell = highlightMatch(cell, searchTerm);
                }
                html += '<td title="' + escapeHtml(pageRows[r][c] || '') + '">' + cell + '</td>';
            }
            html += '</tr>';
        }

        if (pageRows.length === 0) {
            html = '<tr><td colspan="' + (csvData.headers.length + 1) + '" style="text-align:center;padding:20px;color:var(--vscode-descriptionForeground)">No matching rows</td></tr>';
        }

        tbody.innerHTML = html;

        // Attach cell click for copy
        tbody.querySelectorAll('td:not(.row-num)').forEach(function (td) {
            td.addEventListener('dblclick', function () {
                vscode.postMessage({ type: 'copyCell', text: td.getAttribute('title') || td.textContent });
            });
        });

        // Pagination info
        pagInfo.textContent = filteredRows.length === csvData.rows.length
            ? 'Showing ' + (start + 1) + '-' + end + ' of ' + filteredRows.length + ' rows'
            : 'Showing ' + (start + 1) + '-' + end + ' of ' + filteredRows.length + ' filtered rows (total: ' + csvData.rows.length + ')';

        // Pagination buttons
        renderPagination(totalPages);
    }

    function renderPagination(totalPages) {
        var html = '';
        html += '<button ' + (currentPage <= 1 ? 'disabled' : '') + ' data-page="prev">\u25C0</button>';

        // Show max 7 page buttons
        var pages = [];
        if (totalPages <= 7) {
            for (var i = 1; i <= totalPages; i++) { pages.push(i); }
        } else {
            pages.push(1);
            if (currentPage > 3) { pages.push(-1); } // ellipsis
            var rangeStart = Math.max(2, currentPage - 1);
            var rangeEnd = Math.min(totalPages - 1, currentPage + 1);
            for (var i = rangeStart; i <= rangeEnd; i++) { pages.push(i); }
            if (currentPage < totalPages - 2) { pages.push(-1); } // ellipsis
            pages.push(totalPages);
        }

        for (var j = 0; j < pages.length; j++) {
            if (pages[j] === -1) {
                html += '<button disabled>\u2026</button>';
            } else {
                html += '<button data-page="' + pages[j] + '"' +
                    (pages[j] === currentPage ? ' class="active"' : '') +
                    '>' + pages[j] + '</button>';
            }
        }

        html += '<button ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-page="next">\u25B6</button>';
        pagControls.innerHTML = html;

        pagControls.querySelectorAll('button[data-page]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var page = btn.getAttribute('data-page');
                if (page === 'prev') { currentPage = Math.max(1, currentPage - 1); }
                else if (page === 'next') { currentPage = Math.min(totalPages, currentPage + 1); }
                else { currentPage = parseInt(page, 10); }
                renderPage();
                // Scroll table to top
                document.querySelector('.csv-table-wrapper').scrollTop = 0;
            });
        });
    }

    function highlightMatch(text, term) {
        var idx = text.toLowerCase().indexOf(term.toLowerCase());
        if (idx === -1) { return text; }
        return text.substring(0, idx) +
            '<mark>' + text.substring(idx, idx + term.length) + '</mark>' +
            text.substring(idx + term.length);
    }

    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // Event: search
    var searchTimeout = null;
    searchInput.addEventListener('input', function () {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function () {
            searchTerm = searchInput.value.trim();
            applyFilter();
            renderPage();
        }, 200);
    });

    // Event: page size
    pageSizeSelect.addEventListener('change', function () {
        pageSize = parseInt(pageSizeSelect.value, 10);
        currentPage = 1;
        renderPage();
    });

    // Event: export filtered
    exportBtn.addEventListener('click', function () {
        var delimiter = csvData.delimiter === '\t' ? '\t' : ',';
        var lines = [csvData.headers.map(quoteField).join(delimiter)];
        for (var i = 0; i < filteredRows.length; i++) {
            lines.push(filteredRows[i].map(quoteField).join(delimiter));
        }
        vscode.postMessage({ type: 'exportFiltered', csv: lines.join('\n') });
    });

    function quoteField(val) {
        if (!val) { return ''; }
        if (val.indexOf(',') !== -1 || val.indexOf('"') !== -1 || val.indexOf('\n') !== -1) {
            return '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
    }

    // Initial render
    renderHeader();
    renderPage();
})();
