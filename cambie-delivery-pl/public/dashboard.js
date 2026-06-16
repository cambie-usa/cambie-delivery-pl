// =================================================================
// dashboard.js — UI logic, PDF parsing, rendering, PDF export
// =================================================================

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── STATE ─────────────────────────────────────────────────────────
let invoices    = [];   // array of normalised invoice objects
let pendingInv  = null; // invoice being edited in the modal

// ── INIT ──────────────────────────────────────────────────────────
(async function init() {
  setSyncStatus('busy', 'Connecting…');
  try {
    const rows = await loadInvoices();
    invoices = rows.map(rowToInv);
    setSyncStatus('ok', 'Live');
    render();
  } catch (e) {
    setSyncStatus('err', 'Offline');
    showToast('Could not reach database — check config.js credentials.');
    console.error(e);
    renderEmpty();
  }
})();

// ── SYNC STATUS ───────────────────────────────────────────────────
function setSyncStatus(state, label) {
  document.getElementById('syncDot').className   = 'sync-dot ' + state;
  document.getElementById('syncLabel').textContent = label;
}

// ── FILE INPUT ────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => {
  [...e.target.files].forEach(f => parsePDF(f));
  e.target.value = '';
});

const zone = document.getElementById('uploadZone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
zone.addEventListener('drop', e => {
  e.preventDefault();
  zone.classList.remove('drag-over');
  [...e.dataTransfer.files]
    .filter(f => f.type === 'application/pdf')
    .forEach(f => parsePDF(f));
});

// ── PDF PARSING ───────────────────────────────────────────────────
async function parsePDF(file) {
  showToast('Reading ' + file.name + '…');
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc   = await page.getTextContent();
      text += tc.items.map(it => it.str).join(' ') + '\n';
    }
    const inv = extractInvoiceData(text, file.name);
    if (!inv) { showToast('Could not parse invoice — is this a CIN7 PDF?'); return; }
    openModal(inv);
  } catch (err) {
    console.error(err);
    showToast('Error reading PDF.');
  }
}

function extractInvoiceData(text, filename) {
  const invNoMatch = text.match(/INV[-‑](\d+)/i);
  const invNo = invNoMatch ? 'INV-' + invNoMatch[1] : filename.replace('.pdf', '');

  // Customer name: first token(s) after "Name:" before any address detail (digits, comma, or newline)
  const nameMatch = text.match(/Name:\s*([A-Za-z0-9&'\-\s]+?)(?=\s+\d|\s*,|\n)/i);
  let customer = nameMatch ? nameMatch[1].trim() : 'Unknown';

  // Shipping address: street, city, state zip from Ship To block
  // CIN7 format: "Ship To: <Name> <Name> <street> <city> <state> <zip> <country>"
  // We grab the street line (contains digits + street words) and city/state/zip
  let address = '';
  const shipMatch = text.match(/Ship To:\s*([\s\S]+?)(?=Invoice No\.|Customer VAT:|$)/i);
  if (shipMatch) {
    const shipBlock = shipMatch[1].replace(/\s+/g, ' ').trim();
    // Extract street: first sequence with a number followed by words
    const streetMatch = shipBlock.match(/(\d+\s+[\w\s]+(?:Dr|St|Ave|Blvd|Rd|Ln|Way|Ct|Pl|Pkwy|Hwy)[.,#\s\d]*)/i);
    // Extract city/state/zip: pattern like "Richardson TX 75081"
    const cityMatch   = shipBlock.match(/([A-Za-z\s]+,?\s+[A-Z]{2}\s+\d{5})/);
    if (streetMatch) address += streetMatch[1].trim();
    if (cityMatch)   address += (address ? ', ' : '') + cityMatch[1].trim();
  }

  const dateMatch = text.match(/Invoice Date\s*([\d\/]+)/i) || text.match(/(\d{2}\/\d{2}\/\d{4})/);
  const date = dateMatch ? dateMatch[1].trim() : new Date().toLocaleDateString();

  const items = [];
  const pat = /(\d{5,8})\s+([\w\s\-\/]+?)\s+Item\s+([\d.]+)\s+([\d.]+)\s+[\d.]+%\s+([\d.]+)/gi;
  let m;
  while ((m = pat.exec(text)) !== null) {
    const lineTotal = parseFloat(m[5]);
    if (lineTotal > 0) {
      items.push({ code: m[1], description: m[2].trim(), qty: parseFloat(m[3]), unitPrice: parseFloat(m[4]), lineTotal, margin: '' });
    }
  }

  if (items.length === 0) {
    const pat2 = /(\d{5,8})\s+(.*?)\s+([\d.]+)\s+([\d.]+)\s+[\d.]+%\s+([\d.]+)\s+No/gi;
    while ((m = pat2.exec(text)) !== null) {
      items.push({ code: m[1], description: m[2].trim(), qty: parseFloat(m[3]), unitPrice: parseFloat(m[4]), lineTotal: parseFloat(m[5]), margin: '' });
    }
  }

  const totalMatch = text.match(/Total\s+([\d.]+)\s+Total\s+[\d.]+\s+Total\s+([\d.]+)/i);
  const invoiceTotal = totalMatch ? parseFloat(totalMatch[2]) : items.reduce((s, i) => s + i.lineTotal, 0);

  if (!invoiceTotal) return null;

  if (items.length === 0) {
    items.push({ code: '', description: 'Invoice Total', qty: 1, unitPrice: invoiceTotal, lineTotal: invoiceTotal, margin: '' });
  }

  return { invNo, customer, address, date, items, invoiceTotal, delivery: 0, grossProfit: 0, netProfit: 0 };
}

// ── MODAL ─────────────────────────────────────────────────────────
function openModal(inv) {
  pendingInv = JSON.parse(JSON.stringify(inv));

  document.getElementById('modalTitle').textContent = inv.invNo;
  document.getElementById('modalMeta').textContent  = inv.customer + ' · ' + inv.date;

  document.getElementById('invInfo').innerHTML = `
    <div class="inv-info-row"><div class="lbl">Invoice No.</div><div class="val">${inv.invNo}</div></div>
    <div class="inv-info-row"><div class="lbl">Date</div><div class="val">${inv.date}</div></div>
    <div class="inv-info-row"><div class="lbl">Customer</div><div class="val">${inv.customer}</div></div>
    <div class="inv-info-row"><div class="lbl">Delivery Address</div><div class="val" style="font-size:13px">${inv.address || '—'}</div></div>
    <div class="inv-info-row"><div class="lbl">Invoice Total</div><div class="val">${fmt(inv.invoiceTotal)}</div></div>
  `;

  renderItemsTable();
  document.getElementById('deliveryInput').value = inv.delivery || '';
  document.getElementById('modalTotal').textContent = fmt(inv.invoiceTotal);
  updateModalTotals();
  document.getElementById('modalOverlay').classList.add('open');
}

function renderItemsTable() {
  document.getElementById('itemsBody').innerHTML = pendingInv.items.map((item, idx) => `
    <tr>
      <td>
        <div class="product-name">${item.description}</div>
        ${item.code ? `<div class="product-meta">SKU ${item.code}</div>` : ''}
      </td>
      <td class="num mono">${item.qty}</td>
      <td class="num mono">${fmt(item.unitPrice)}</td>
      <td class="num mono">${fmt(item.lineTotal)}</td>
      <td class="num">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px">
          <input type="number" class="margin-input" value="${item.margin}"
            min="0" max="100" step="0.1" placeholder="0"
            oninput="updateItemMargin(${idx}, this.value)">
          <span style="font-size:12px;color:var(--ink-muted)">%</span>
        </div>
      </td>
      <td class="num mono profit" id="gp_${idx}">${item.margin !== '' ? fmt(item.lineTotal * (parseFloat(item.margin)||0) / 100) : '—'}</td>
    </tr>
  `).join('');
}

function updateItemMargin(idx, val) {
  pendingInv.items[idx].margin = val;
  const gp = pendingInv.items[idx].lineTotal * (parseFloat(val)||0) / 100;
  const el = document.getElementById('gp_' + idx);
  if (el) el.textContent = val !== '' ? fmt(gp) : '—';
  updateModalTotals();
}

function updateModalTotals() {
  if (!pendingInv) return;
  const gross    = pendingInv.items.reduce((s, it) => s + (it.margin !== '' ? it.lineTotal * (parseFloat(it.margin)||0) / 100 : 0), 0);
  const delivery = parseFloat(document.getElementById('deliveryInput').value) || 0;
  const net      = gross - delivery;
  const total    = pendingInv.invoiceTotal;

  document.getElementById('modalGross').textContent     = fmt(gross);
  document.getElementById('summaryGross').textContent   = fmt(gross);
  document.getElementById('summaryGrossPct').textContent = total > 0 ? pct(gross / total) : '0.0%';
  document.getElementById('summaryDelivery').textContent = fmt(delivery);
  const netEl = document.getElementById('summaryNet');
  netEl.textContent = fmt(net);
  netEl.className   = 'summary-value ' + (net >= 0 ? 'profit' : 'loss-text');
  document.getElementById('summaryNetPct').textContent  = total > 0 ? pct(net / total) : '0.0%';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  pendingInv = null;
}

async function saveInvoice() {
  if (!pendingInv) return;

  const delivery    = parseFloat(document.getElementById('deliveryInput').value) || 0;
  const grossProfit = pendingInv.items.reduce((s, it) => s + (it.margin !== '' ? it.lineTotal * (parseFloat(it.margin)||0) / 100 : 0), 0);
  const netProfit   = grossProfit - delivery;

  const inv = { ...pendingInv, delivery, grossProfit, netProfit };

  const btn = document.getElementById('saveBtn');
  btn.disabled     = true;
  btn.textContent  = 'Saving…';
  setSyncStatus('busy', 'Saving…');

  try {
    const saved = await upsertInvoice(inv);
    inv.id = saved.id;

    const idx = invoices.findIndex(i => i.invNo === inv.invNo);
    if (idx >= 0) invoices[idx] = inv; else invoices.unshift(inv);

    closeModal();
    render();
    setSyncStatus('ok', 'Saved');
    showToast('Invoice saved ✓');
  } catch (err) {
    console.error(err);
    setSyncStatus('err', 'Save failed');
    showToast('Save failed — check console for details.');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save Invoice';
  }
}

async function deleteInvoice(invNo) {
  if (!confirm('Remove invoice ' + invNo + '?')) return;
  setSyncStatus('busy', 'Deleting…');
  try {
    await deleteInvoice(invNo);
    invoices = invoices.filter(i => i.invNo !== invNo);
    render();
    setSyncStatus('ok', 'Live');
    showToast('Invoice removed.');
  } catch (err) {
    setSyncStatus('err', 'Error');
    showToast('Delete failed.');
    console.error(err);
  }
}

function editInvoice(invNo) {
  const inv = invoices.find(i => i.invNo === invNo);
  if (inv) openModal(inv);
}

// ── RENDER ────────────────────────────────────────────────────────
function render() {
  renderKPIs();
  renderInvoicesTable();
  renderCustomerTable();
  document.getElementById('lastRefreshed').textContent =
    'Last updated ' + new Date().toLocaleTimeString();
}

function renderEmpty() {
  document.getElementById('invoicesBody').innerHTML =
    '<tr><td colspan="10"><div class="empty-state"><p>No invoices yet — add a PDF to get started.</p></div></td></tr>';
  document.getElementById('customerBody').innerHTML =
    '<tr><td colspan="8"><div class="empty-state"><p>Customer breakdown will appear here.</p></div></td></tr>';
}

function renderKPIs() {
  const totalSales    = invoices.reduce((s, i) => s + i.invoiceTotal, 0);
  const totalGross    = invoices.reduce((s, i) => s + (i.grossProfit || 0), 0);
  const totalDelivery = invoices.reduce((s, i) => s + (i.delivery || 0), 0);
  const totalNet      = invoices.reduce((s, i) => s + (i.netProfit || 0), 0);

  set('kpiSales',       fmt(totalSales));
  set('kpiSalesCount',  invoices.length + ' invoice' + (invoices.length !== 1 ? 's' : ''));
  set('kpiGross',       fmt(totalGross));
  cls('kpiGross',       'kpi-value ' + (totalGross >= 0 ? 'positive' : 'negative'));
  set('kpiGrossPct',    totalSales > 0 ? pct(totalGross / totalSales) + ' margin' : '— margin');
  set('kpiDelivery',    fmt(totalDelivery));
  set('kpiDeliveryPct', totalSales > 0 ? pct(totalDelivery / totalSales) + ' of sales' : '— of sales');
  set('kpiNet',         fmt(totalNet));
  cls('kpiNet',         'kpi-value ' + (totalNet >= 0 ? 'positive' : 'negative'));
  set('kpiNetPct',      totalSales > 0 ? pct(totalNet / totalSales) + ' margin' : '— margin');
}

function renderInvoicesTable() {
  const tbody = document.getElementById('invoicesBody');
  if (!invoices.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><p>No invoices yet — add a PDF to get started.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = invoices.map(inv => {
    const gpPct  = inv.invoiceTotal > 0 ? inv.grossProfit / inv.invoiceTotal : 0;
    const netPct = inv.invoiceTotal > 0 ? inv.netProfit  / inv.invoiceTotal : 0;
    const isPos  = inv.netProfit >= 0;
    return `<tr>
      <td><strong>${inv.invNo}</strong></td>
      <td>${inv.customer}</td>
      <td>${inv.date}</td>
      <td class="num mono">${fmt(inv.invoiceTotal)}</td>
      <td class="num mono" style="color:var(--profit)">${fmt(inv.grossProfit)}</td>
      <td class="num mono">${pct(gpPct)}</td>
      <td class="num mono" style="color:var(--accent)">${fmt(inv.delivery)}</td>
      <td class="num mono" style="color:${isPos ? 'var(--profit)' : 'var(--loss)'};font-weight:600">${fmt(inv.netProfit)}</td>
      <td class="num"><span class="badge ${isPos ? 'badge-profit' : 'badge-loss'}">${pct(netPct)}</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="editInvoice('${inv.invNo}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteInvoice('${inv.invNo}')">Remove</button>
      </td>
    </tr>`;
  }).join('');
}

function renderCustomerTable() {
  const tbody = document.getElementById('customerBody');
  if (!invoices.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><p>Customer breakdown will appear here.</p></div></td></tr>';
    return;
  }
  const map = {};
  invoices.forEach(inv => {
    if (!map[inv.customer]) map[inv.customer] = { count: 0, sales: 0, gross: 0, delivery: 0, net: 0 };
    map[inv.customer].count++;
    map[inv.customer].sales    += inv.invoiceTotal;
    map[inv.customer].gross    += inv.grossProfit || 0;
    map[inv.customer].delivery += inv.delivery    || 0;
    map[inv.customer].net      += inv.netProfit   || 0;
  });

  tbody.innerHTML = Object.entries(map)
    .sort((a, b) => b[1].sales - a[1].sales)
    .map(([name, d]) => {
      const gp = d.sales > 0 ? d.gross / d.sales : 0;
      const np = d.sales > 0 ? d.net   / d.sales : 0;
      return `<tr>
        <td><strong>${name}</strong></td>
        <td class="num">${d.count}</td>
        <td class="num mono">${fmt(d.sales)}</td>
        <td class="num mono" style="color:var(--profit)">${fmt(d.gross)}</td>
        <td class="num mono">${pct(gp)}</td>
        <td class="num mono" style="color:var(--accent)">${fmt(d.delivery)}</td>
        <td class="num mono" style="color:${d.net >= 0 ? 'var(--profit)' : 'var(--loss)'};font-weight:600">${fmt(d.net)}</td>
        <td class="num"><span class="badge ${d.net >= 0 ? 'badge-profit' : 'badge-loss'}">${pct(np)}</span></td>
      </tr>`;
    }).join('');
}

// ── PDF EXPORT ────────────────────────────────────────────────────
async function generatePDF() {
  if (!invoices.length) { showToast('No invoices to export.'); return; }
  showToast('Generating PDF report…');

  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  const doc  = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);

  const GREEN   = rgb(0.10, 0.29, 0.23);
  const ACCENT  = rgb(0.79, 0.38, 0.16);
  const MUTED   = rgb(0.42, 0.42, 0.42);
  const PROFIT  = rgb(0.10, 0.42, 0.23);
  const LOSS    = rgb(0.72, 0.20, 0.20);
  const BLACK   = rgb(0.07, 0.07, 0.07);
  const RULE    = rgb(0.88, 0.88, 0.85);
  const ROWALT  = rgb(0.99, 0.99, 0.98);
  const HEADBG  = rgb(0.95, 0.94, 0.92);

  const W = 612, H = 792, M = 44;
  const now = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

  const totalSales    = invoices.reduce((s, i) => s + i.invoiceTotal, 0);
  const totalGross    = invoices.reduce((s, i) => s + (i.grossProfit || 0), 0);
  const totalDelivery = invoices.reduce((s, i) => s + (i.delivery || 0), 0);
  const totalNet      = invoices.reduce((s, i) => s + (i.netProfit || 0), 0);

  // ── PAGE FACTORY ──
  function newPage() {
    const p = doc.addPage([W, H]);
    // header bar
    p.drawRectangle({ x: 0, y: H - 68, width: W, height: 68, color: GREEN });
    p.drawText('cambie', { x: M, y: H - 40, size: 20, font: bold, color: rgb(1,1,1) });
    p.drawText('Local Delivery P&L Report', { x: M, y: H - 57, size: 9, font: reg, color: rgb(1,1,1,0.7) });
    p.drawText('Generated: ' + now, { x: W - M - 110, y: H - 40, size: 8, font: reg, color: rgb(1,1,1,0.65) });
    // footer
    p.drawText('Cambie Inc. · 10630 Newkirk St, Ste 100, Dallas TX 75220 · Confidential', { x: M, y: 22, size: 7, font: reg, color: MUTED });
    return { p, y: H - 84 };
  }

  function sectionTitle(ctx, title) {
    if (ctx.y < 100) ctx = newPage();
    ctx.p.drawText(title, { x: M, y: ctx.y, size: 8, font: bold, color: MUTED });
    ctx.y -= 4;
    ctx.p.drawLine({ start: { x: M, y: ctx.y }, end: { x: W - M, y: ctx.y }, thickness: 0.5, color: RULE });
    ctx.y -= 14;
    return ctx;
  }

  function tableHeader(ctx, cols) {
    ctx.p.drawRectangle({ x: M, y: ctx.y - 14, width: W - M*2, height: 18, color: HEADBG });
    cols.forEach(col => {
      const lw  = bold.widthOfTextAtSize(col.label, 7);
      const tx  = col.align === 'right' ? col.x + col.w - lw : col.x + 3;
      ctx.p.drawText(col.label, { x: tx, y: ctx.y - 10, size: 7, font: bold, color: MUTED });
    });
    ctx.y -= 18;
    return ctx;
  }

  function tableRow(ctx, cols, vals, colors, ri) {
    if (ctx.y < 60) { ctx = newPage(); }
    if (ri % 2 === 0) ctx.p.drawRectangle({ x: M, y: ctx.y - 13, width: W - M*2, height: 16, color: ROWALT });
    cols.forEach((col, ci) => {
      const v  = vals[ci];
      const vw = reg.widthOfTextAtSize(v, 8);
      const tx = col.align === 'right' ? col.x + col.w - vw : col.x + 3;
      ctx.p.drawText(v, { x: tx, y: ctx.y - 10, size: 8, font: ci === 0 ? bold : reg, color: colors[ci] || BLACK });
    });
    ctx.p.drawLine({ start: { x: M, y: ctx.y - 14 }, end: { x: W - M, y: ctx.y - 14 }, thickness: 0.3, color: RULE });
    ctx.y -= 16;
    return ctx;
  }

  // ── PAGE 1 ──
  let ctx = newPage();

  // KPI summary boxes
  const kpiBoxW = (W - M*2 - 9) / 4;
  const kpis = [
    { label: 'TOTAL SALES',      value: fmtPDF(totalSales),    sub: invoices.length + ' invoices' },
    { label: 'GROSS PROFIT',     value: fmtPDF(totalGross),    sub: pct(totalSales > 0 ? totalGross / totalSales : 0) + ' margin' },
    { label: 'DELIVERY EXPENSE', value: fmtPDF(totalDelivery), sub: pct(totalSales > 0 ? totalDelivery / totalSales : 0) + ' of sales' },
    { label: 'NET PROFIT',       value: fmtPDF(totalNet),      sub: pct(totalSales > 0 ? totalNet / totalSales : 0) + ' margin' },
  ];
  kpis.forEach((k, i) => {
    const bx = M + i * (kpiBoxW + 3);
    ctx.p.drawRectangle({ x: bx, y: ctx.y - 56, width: kpiBoxW, height: 60, color: rgb(0.97,0.96,0.95), borderColor: RULE, borderWidth: 0.5 });
    ctx.p.drawText(k.label, { x: bx + 9, y: ctx.y - 14, size: 7,  font: bold, color: MUTED });
    const vc = i === 3 ? (totalNet >= 0 ? PROFIT : LOSS) : BLACK;
    ctx.p.drawText(k.value, { x: bx + 9, y: ctx.y - 30, size: 14, font: bold, color: vc });
    ctx.p.drawText(k.sub,   { x: bx + 9, y: ctx.y - 45, size: 8,  font: reg,  color: MUTED });
  });
  ctx.y -= 72;

  // Invoice detail table
  ctx = sectionTitle(ctx, 'INVOICE DETAIL');
  const invCols = [
    { label: 'Invoice',      x: M,       w: 72,  align: 'left'  },
    { label: 'Customer',     x: M+72,    w: 96,  align: 'left'  },
    { label: 'Date',         x: M+168,   w: 62,  align: 'left'  },
    { label: 'Sales',        x: M+230,   w: 64,  align: 'right' },
    { label: 'Gross Profit', x: M+294,   w: 70,  align: 'right' },
    { label: 'GP%',          x: M+364,   w: 34,  align: 'right' },
    { label: 'Delivery',     x: M+398,   w: 60,  align: 'right' },
    { label: 'Net Profit',   x: M+458,   w: 62,  align: 'right' },
    { label: 'Net%',         x: M+520,   w: 32,  align: 'right' },
  ];
  ctx = tableHeader(ctx, invCols);

  invoices.forEach((inv, ri) => {
    const gpP = inv.invoiceTotal > 0 ? inv.grossProfit / inv.invoiceTotal : 0;
    const npP = inv.invoiceTotal > 0 ? inv.netProfit   / inv.invoiceTotal : 0;
    const colors = [BLACK, BLACK, BLACK, BLACK, PROFIT, MUTED, ACCENT, inv.netProfit >= 0 ? PROFIT : LOSS, MUTED];
    ctx = tableRow(ctx, invCols,
      [inv.invNo, inv.customer, inv.date, fmtPDF(inv.invoiceTotal), fmtPDF(inv.grossProfit), pct(gpP), fmtPDF(inv.delivery), fmtPDF(inv.netProfit), pct(npP)],
      colors, ri);
  });

  // Totals row
  ctx.p.drawRectangle({ x: M, y: ctx.y - 14, width: W - M*2, height: 18, color: rgb(0.93,0.95,0.92) });
  const totVals = ['TOTAL', '', '', fmtPDF(totalSales), fmtPDF(totalGross), pct(totalSales > 0 ? totalGross/totalSales : 0), fmtPDF(totalDelivery), fmtPDF(totalNet), pct(totalSales > 0 ? totalNet/totalSales : 0)];
  invCols.forEach((col, ci) => {
    const v  = totVals[ci];
    const vw = bold.widthOfTextAtSize(v, 8);
    const tx = col.align === 'right' ? col.x + col.w - vw : col.x + 3;
    const vc = ci === 7 ? (totalNet >= 0 ? PROFIT : LOSS) : ci === 4 ? PROFIT : ci === 6 ? ACCENT : BLACK;
    ctx.p.drawText(v, { x: tx, y: ctx.y - 10, size: 8, font: bold, color: vc });
  });
  ctx.y -= 28;

  // Customer table
  ctx = sectionTitle(ctx, 'P&L BY CUSTOMER');
  const custCols = [
    { label: 'Customer',     x: M,      w: 120, align: 'left'  },
    { label: 'Invoices',     x: M+120,  w: 46,  align: 'right' },
    { label: 'Sales',        x: M+166,  w: 68,  align: 'right' },
    { label: 'Gross Profit', x: M+234,  w: 70,  align: 'right' },
    { label: 'GP%',          x: M+304,  w: 36,  align: 'right' },
    { label: 'Delivery',     x: M+340,  w: 62,  align: 'right' },
    { label: 'Net Profit',   x: M+402,  w: 68,  align: 'right' },
    { label: 'Net%',         x: M+470,  w: 36,  align: 'right' },
  ];
  ctx = tableHeader(ctx, custCols);

  const custMap = {};
  invoices.forEach(inv => {
    if (!custMap[inv.customer]) custMap[inv.customer] = { count: 0, sales: 0, gross: 0, delivery: 0, net: 0 };
    custMap[inv.customer].count++;
    custMap[inv.customer].sales    += inv.invoiceTotal;
    custMap[inv.customer].gross    += inv.grossProfit || 0;
    custMap[inv.customer].delivery += inv.delivery    || 0;
    custMap[inv.customer].net      += inv.netProfit   || 0;
  });

  Object.entries(custMap)
    .sort((a, b) => b[1].sales - a[1].sales)
    .forEach(([name, d], ri) => {
      const gp = d.sales > 0 ? d.gross / d.sales : 0;
      const np = d.sales > 0 ? d.net   / d.sales : 0;
      const colors = [BLACK, BLACK, BLACK, PROFIT, MUTED, ACCENT, d.net >= 0 ? PROFIT : LOSS, MUTED];
      ctx = tableRow(ctx, custCols,
        [name, String(d.count), fmtPDF(d.sales), fmtPDF(d.gross), pct(gp), fmtPDF(d.delivery), fmtPDF(d.net), pct(np)],
        colors, ri);
    });

  const bytes = await doc.save();
  const blob  = new Blob([bytes], { type: 'application/pdf' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = 'Cambie_Delivery_PL_' + now.replace(/,?\s+/g, '_') + '.pdf';
  a.click();
  URL.revokeObjectURL(url);
  showToast('PDF exported ✓');
}

// ── UTILS ─────────────────────────────────────────────────────────
function fmt(n)    { return '$' + (n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtPDF(n) { return '$' + (n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function pct(n)    { return ((n||0)*100).toFixed(1) + '%'; }
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function cls(id, c) { const el = document.getElementById(id); if (el) el.className   = c; }

function showToast(msg) {
  const t  = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── TAB SWITCHING ─────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  document.querySelector(`.tab-btn[onclick="switchTab('${name}')"]`).classList.add('active');

  if (name === 'customers') renderCustomerTab();
  if (name === 'areas')     renderAreasTab();
}

// ── CUSTOMER TAB ──────────────────────────────────────────────────
function renderCustomerTab() {
  const q = (document.getElementById('customerSearch')?.value || '').toLowerCase();

  const map = {};
  invoices.forEach(inv => {
    if (!map[inv.customer]) map[inv.customer] = { invoices: [], address: inv.address || '' };
    map[inv.customer].invoices.push(inv);
    if (inv.address && !map[inv.customer].address) map[inv.customer].address = inv.address;
  });

  const rows = Object.entries(map)
    .filter(([name]) => !q || name.toLowerCase().includes(q))
    .map(([name, d]) => {
      const sales    = d.invoices.reduce((s, i) => s + i.invoiceTotal, 0);
      const gross    = d.invoices.reduce((s, i) => s + (i.grossProfit || 0), 0);
      const delivery = d.invoices.reduce((s, i) => s + (i.delivery || 0), 0);
      const net      = d.invoices.reduce((s, i) => s + (i.netProfit || 0), 0);
      const lastDate = d.invoices.map(i => i.date).sort().reverse()[0];
      return { name, address: d.address, count: d.invoices.length, sales, gross, delivery, net, lastDate };
    })
    .sort((a, b) => b.sales - a.sales);

  const tbody = document.getElementById('customerBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><p>No customers found.</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const gp = r.sales > 0 ? r.gross / r.sales : 0;
    const np = r.sales > 0 ? r.net   / r.sales : 0;
    return `<tr class="clickable" onclick="showCustomerDetail('${r.name.replace(/'/g,"\\'")}')">
      <td><strong>${r.name}</strong>${r.address ? `<div style="font-size:11px;color:var(--ink-muted);margin-top:2px">${r.address}</div>` : ''}</td>
      <td>${r.lastDate || '—'}</td>
      <td class="num">${r.count}</td>
      <td class="num mono">${fmt(r.sales)}</td>
      <td class="num mono" style="color:var(--profit)">${fmt(r.gross)}</td>
      <td class="num mono">${pct(gp)}</td>
      <td class="num mono" style="color:var(--accent)">${fmt(r.delivery)}</td>
      <td class="num mono" style="color:${r.net >= 0 ? 'var(--profit)' : 'var(--loss)'};font-weight:600">${fmt(r.net)}</td>
      <td class="num"><span class="badge ${r.net >= 0 ? 'badge-profit' : 'badge-loss'}">${pct(np)}</span></td>
    </tr>`;
  }).join('');
}

function showCustomerDetail(name) {
  const custInvoices = invoices.filter(i => i.name === name || i.customer === name);
  const address = custInvoices.find(i => i.address)?.address || '';

  const sales    = custInvoices.reduce((s, i) => s + i.invoiceTotal, 0);
  const gross    = custInvoices.reduce((s, i) => s + (i.grossProfit || 0), 0);
  const delivery = custInvoices.reduce((s, i) => s + (i.delivery || 0), 0);
  const net      = custInvoices.reduce((s, i) => s + (i.netProfit || 0), 0);
  const gpPct    = sales > 0 ? gross / sales : 0;
  const netPct   = sales > 0 ? net   / sales : 0;

  document.getElementById('detailName').textContent    = name;
  document.getElementById('detailAddress').textContent = address || '';

  document.getElementById('detailKPIs').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Total Sales</div><div class="kpi-value">${fmt(sales)}</div><div class="kpi-sub">${custInvoices.length} invoices</div></div>
    <div class="kpi-card"><div class="kpi-label">Gross Profit</div><div class="kpi-value positive">${fmt(gross)}</div><div class="kpi-sub">${pct(gpPct)} margin</div></div>
    <div class="kpi-card"><div class="kpi-label">Delivery Cost</div><div class="kpi-value">${fmt(delivery)}</div><div class="kpi-sub">${pct(sales > 0 ? delivery/sales : 0)} of sales</div></div>
    <div class="kpi-card"><div class="kpi-label">Net Profit</div><div class="kpi-value ${net >= 0 ? 'positive' : 'negative'}">${fmt(net)}</div><div class="kpi-sub">${pct(netPct)} margin</div></div>
  `;

  document.getElementById('detailInvoices').innerHTML = [...custInvoices]
    .sort((a, b) => b.date > a.date ? 1 : -1)
    .map(inv => {
      const gp = inv.invoiceTotal > 0 ? inv.grossProfit / inv.invoiceTotal : 0;
      const np = inv.invoiceTotal > 0 ? inv.netProfit   / inv.invoiceTotal : 0;
      return `<tr>
        <td><strong>${inv.invNo}</strong></td>
        <td>${inv.date}</td>
        <td class="num mono">${fmt(inv.invoiceTotal)}</td>
        <td class="num mono" style="color:var(--profit)">${fmt(inv.grossProfit)}</td>
        <td class="num mono">${pct(gp)}</td>
        <td class="num mono" style="color:var(--accent)">${fmt(inv.delivery)}</td>
        <td class="num mono" style="color:${inv.netProfit >= 0 ? 'var(--profit)' : 'var(--loss)'};font-weight:600">${fmt(inv.netProfit)}</td>
        <td class="num"><span class="badge ${inv.netProfit >= 0 ? 'badge-profit' : 'badge-loss'}">${pct(np)}</span></td>
        <td><button class="btn btn-ghost btn-sm" onclick="editInvoice('${inv.invNo}')">Edit</button></td>
      </tr>`;
    }).join('');

  document.getElementById('customerList').classList.add('hidden');
  document.getElementById('customerDetail').classList.remove('hidden');
}

function clearCustomerDetail() {
  document.getElementById('customerDetail').classList.add('hidden');
  document.getElementById('customerList').classList.remove('hidden');
}

// ── AREAS TAB ─────────────────────────────────────────────────────
function parseCity(address) {
  if (!address) return 'Unknown';
  // Match "City TX 75XXX" pattern
  const m = address.match(/([A-Za-z\s]+),?\s+TX\s+\d{5}/i);
  if (m) return m[1].trim();
  // Fallback: last word-group before state abbreviation
  const m2 = address.match(/([A-Za-z\s]+)\s+TX/i);
  if (m2) return m2[1].trim();
  return 'Unknown';
}

function renderAreasTab() {
  const map = {};
  invoices.forEach(inv => {
    const city = parseCity(inv.address);
    if (!map[city]) map[city] = { count: 0, sales: 0, gross: 0, delivery: 0, net: 0 };
    map[city].count++;
    map[city].sales    += inv.invoiceTotal;
    map[city].gross    += inv.grossProfit || 0;
    map[city].delivery += inv.delivery    || 0;
    map[city].net      += inv.netProfit   || 0;
  });

  const rows = Object.entries(map).sort((a, b) => b[1].net - a[1].net);

  // Top-level area KPIs
  const totalAreas     = rows.length;
  const profitAreas    = rows.filter(([, d]) => d.net >= 0).length;
  const bestArea       = rows[0];
  const highestAvgDel  = [...rows].sort((a, b) => (b[1].delivery/b[1].count) - (a[1].delivery/a[1].count))[0];

  document.getElementById('areasKPIs').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Areas Served</div><div class="kpi-value">${totalAreas}</div><div class="kpi-sub">${profitAreas} profitable</div></div>
    <div class="kpi-card"><div class="kpi-label">Most Profitable Area</div><div class="kpi-value" style="font-size:18px">${bestArea ? bestArea[0] : '—'}</div><div class="kpi-sub">${bestArea ? fmt(bestArea[1].net) + ' net' : ''}</div></div>
    <div class="kpi-card"><div class="kpi-label">Highest Avg Delivery Cost</div><div class="kpi-value" style="font-size:18px">${highestAvgDel ? highestAvgDel[0] : '—'}</div><div class="kpi-sub">${highestAvgDel ? fmt(highestAvgDel[1].delivery / highestAvgDel[1].count) + ' avg' : ''}</div></div>
    <div class="kpi-card"><div class="kpi-label">Total Delivery Spend</div><div class="kpi-value">${fmt(invoices.reduce((s,i) => s + (i.delivery||0), 0))}</div><div class="kpi-sub">across all areas</div></div>
  `;

  const tbody = document.getElementById('areasBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><p>No delivery address data yet. Make sure invoices have shipping addresses.</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(([city, d], ri) => {
    const gp      = d.sales > 0 ? d.gross    / d.sales : 0;
    const np      = d.sales > 0 ? d.net      / d.sales : 0;
    const avgDel  = d.count > 0 ? d.delivery / d.count : 0;
    return `<tr>
      <td><span class="rank-pill">${ri + 1}</span><strong>${city}</strong></td>
      <td class="num">${d.count}</td>
      <td class="num mono">${fmt(d.sales)}</td>
      <td class="num mono" style="color:var(--profit)">${fmt(d.gross)}</td>
      <td class="num mono">${pct(gp)}</td>
      <td class="num mono" style="color:var(--accent)">${fmt(d.delivery)}</td>
      <td class="num mono" style="color:var(--accent)">${fmt(avgDel)}</td>
      <td class="num mono" style="color:${d.net >= 0 ? 'var(--profit)' : 'var(--loss)'};font-weight:600">${fmt(d.net)}</td>
      <td class="num"><span class="badge ${d.net >= 0 ? 'badge-profit' : 'badge-loss'}">${pct(np)}</span></td>
    </tr>`;
  }).join('');
}
