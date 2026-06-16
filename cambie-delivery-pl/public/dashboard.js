// =================================================================
// dashboard.js — UI logic, PDF parsing, rendering, PDF export
// =================================================================

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── STATE ─────────────────────────────────────────────────────────
let invoices   = [];
let pendingInv = null;
let activeFilter = 'all';
let activeTab    = 'overview';

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
  }
})();

// ── DATE FILTERING ────────────────────────────────────────────────
function parseInvDate(dateStr) {
  // handles MM/DD/YYYY
  const [m, d, y] = (dateStr || '').split('/');
  if (!y) return null;
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

function filterInvoices() {
  if (activeFilter === 'all') return invoices;
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let from, to;
  if (activeFilter === 'week') {
    const day = today.getDay();
    from = new Date(today); from.setDate(today.getDate() - day);
    to   = new Date();
  } else if (activeFilter === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to   = new Date();
  } else if (activeFilter === 'lastmonth') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (activeFilter === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    from = new Date(now.getFullYear(), q * 3, 1);
    to   = new Date();
  } else if (activeFilter === 'year') {
    from = new Date(now.getFullYear(), 0, 1);
    to   = new Date();
  }

  return invoices.filter(inv => {
    const d = parseInvDate(inv.date);
    if (!d) return false;
    return d >= from && d <= to;
  });
}

function setFilter(f, tab) {
  activeFilter = f;
  // sync pill active state across all filter bars
  document.querySelectorAll('.pill').forEach(p => {
    const onclick = p.getAttribute('onclick') || '';
    p.classList.toggle('active', onclick.includes(`'${f}'`));
  });
  render();
}

// ── TAB SWITCHING ─────────────────────────────────────────────────
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  document.querySelector(`.tab-btn[onclick="switchTab('${name}')"]`).classList.add('active');
  render();
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
  [...e.dataTransfer.files].filter(f => f.type === 'application/pdf').forEach(f => parsePDF(f));
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

  const nameMatch = text.match(/Name:\s*([A-Za-z0-9&'\-\s]+?)(?=\s+\d|\s*,|\n)/i);
  let customer = nameMatch ? nameMatch[1].trim() : 'Unknown';

  let address = '';
  const shipMatch = text.match(/Ship To:\s*([\s\S]+?)(?=Invoice No\.|Customer VAT:|$)/i);
  if (shipMatch) {
    const shipBlock = shipMatch[1].replace(/\s+/g, ' ').trim();
    const streetMatch = shipBlock.match(/(\d+\s+[\w\s]+(?:Dr|St|Ave|Blvd|Rd|Ln|Way|Ct|Pl|Pkwy|Hwy)[.,#\s\d]*)/i);
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
    if (lineTotal > 0) items.push({ code: m[1], description: m[2].trim(), qty: parseFloat(m[3]), unitPrice: parseFloat(m[4]), lineTotal, margin: '' });
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
  if (items.length === 0) items.push({ code: '', description: 'Invoice Total', qty: 1, unitPrice: invoiceTotal, lineTotal: invoiceTotal, margin: '' });

  return { invNo, customer, address, date, items, invoiceTotal, delivery: 0, courier: '', grossProfit: 0, netProfit: 0 };
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
    <div class="inv-info-row"><div class="lbl">Delivery Address</div><div class="val">${inv.address || '—'}</div></div>
    <div class="inv-info-row"><div class="lbl">Invoice Total</div><div class="val">${fmt(inv.invoiceTotal)}</div></div>
  `;
  renderItemsTable();
  document.getElementById('deliveryInput').value  = inv.delivery || '';
  document.getElementById('courierSelect').value  = inv.courier  || '';
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
  document.getElementById('modalGross').textContent      = fmt(gross);
  document.getElementById('summaryGross').textContent    = fmt(gross);
  document.getElementById('summaryGrossPct').textContent = total > 0 ? pct(gross / total) : '0.0%';
  document.getElementById('summaryDelivery').textContent = fmt(delivery);
  const netEl = document.getElementById('summaryNet');
  netEl.textContent = fmt(net);
  netEl.className   = 'summary-value ' + (net >= 0 ? 'profit' : 'loss-text');
  document.getElementById('summaryNetPct').textContent = total > 0 ? pct(net / total) : '0.0%';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  pendingInv = null;
}

async function saveInvoice() {
  if (!pendingInv) return;
  const delivery    = parseFloat(document.getElementById('deliveryInput').value) || 0;
  const courier     = document.getElementById('courierSelect').value;
  const grossProfit = pendingInv.items.reduce((s, it) => s + (it.margin !== '' ? it.lineTotal * (parseFloat(it.margin)||0) / 100 : 0), 0);
  const netProfit   = grossProfit - delivery;
  const inv = { ...pendingInv, delivery, courier, grossProfit, netProfit };

  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  setSyncStatus('busy', 'Saving…');
  try {
    const saved = await upsertInvoice(inv);
    inv.id = saved.id;
    const idx = invoices.findIndex(i => i.invNo === inv.invNo);
    if (idx >= 0) invoices[idx] = inv; else invoices.unshift(inv);
    closeModal(); render();
    setSyncStatus('ok', 'Saved'); showToast('Invoice saved ✓');
  } catch (err) {
    console.error(err);
    setSyncStatus('err', 'Save failed'); showToast('Save failed — check console.');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Invoice';
  }
}

async function deleteInvoice(invNo) {
  if (!confirm('Remove invoice ' + invNo + '?')) return;
  setSyncStatus('busy', 'Deleting…');
  try {
    await dbDeleteInvoice(invNo);
    invoices = invoices.filter(i => i.invNo !== invNo);
    render(); setSyncStatus('ok', 'Live'); showToast('Invoice removed.');
  } catch (err) {
    setSyncStatus('err', 'Error'); showToast('Delete failed.'); console.error(err);
  }
}

function editInvoice(invNo) {
  const inv = invoices.find(i => i.invNo === invNo);
  if (inv) openModal(inv);
}

// ── RENDER (dispatcher) ───────────────────────────────────────────
function render() {
  const filtered = filterInvoices();
  const label = filtered.length + ' invoice' + (filtered.length !== 1 ? 's' : '');
  set('filterCount', activeFilter !== 'all' ? label : '');
  set('lastRefreshed', 'Last updated ' + new Date().toLocaleTimeString());
  renderKPIs(filtered);
  renderInvoicesTable(filtered);
  if (activeTab === 'customers') renderCustomerTab(filtered);
  if (activeTab === 'areas')     renderAreasTab(filtered);
  if (activeTab === 'couriers')  renderCouriersTab(filtered);
}

// ── KPIs ──────────────────────────────────────────────────────────
function renderKPIs(filtered) {
  const totalSales    = filtered.reduce((s, i) => s + i.invoiceTotal, 0);
  const totalGross    = filtered.reduce((s, i) => s + (i.grossProfit || 0), 0);
  const totalDelivery = filtered.reduce((s, i) => s + (i.delivery || 0), 0);
  const totalNet      = filtered.reduce((s, i) => s + (i.netProfit  || 0), 0);
  set('kpiSales',       fmt(totalSales));
  set('kpiSalesCount',  filtered.length + ' invoice' + (filtered.length !== 1 ? 's' : ''));
  set('kpiGross',       fmt(totalGross));
  cls('kpiGross',       'kpi-value ' + (totalGross >= 0 ? 'positive' : 'negative'));
  set('kpiGrossPct',    totalSales > 0 ? pct(totalGross / totalSales) + ' margin' : '— margin');
  set('kpiDelivery',    fmt(totalDelivery));
  set('kpiDeliveryPct', totalSales > 0 ? pct(totalDelivery / totalSales) + ' of sales' : '— of sales');
  set('kpiNet',         fmt(totalNet));
  cls('kpiNet',         'kpi-value ' + (totalNet >= 0 ? 'positive' : 'negative'));
  set('kpiNetPct',      totalSales > 0 ? pct(totalNet / totalSales) + ' margin' : '— margin');
}

// ── INVOICES TABLE ────────────────────────────────────────────────
function renderInvoicesTable(filtered) {
  const tbody = document.getElementById('invoicesBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="11"><div class="empty-state"><p>No invoices for this period.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(inv => {
    const gpPct  = inv.invoiceTotal > 0 ? inv.grossProfit / inv.invoiceTotal : 0;
    const netPct = inv.invoiceTotal > 0 ? inv.netProfit   / inv.invoiceTotal : 0;
    const isPos  = inv.netProfit >= 0;
    return `<tr>
      <td><strong>${inv.invNo}</strong></td>
      <td>${inv.customer}</td>
      <td>${inv.date}</td>
      <td>${courierPill(inv.courier)}</td>
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

// ── CUSTOMERS TAB ─────────────────────────────────────────────────
function renderCustomerTab(filtered) {
  filtered = filtered || filterInvoices();
  const q = (document.getElementById('customerSearch')?.value || '').toLowerCase();
  const map = {};
  filtered.forEach(inv => {
    if (!map[inv.customer]) map[inv.customer] = { invoices: [], address: inv.address || '' };
    map[inv.customer].invoices.push(inv);
    if (inv.address && !map[inv.customer].address) map[inv.customer].address = inv.address;
  });

  const rows = Object.entries(map)
    .filter(([name]) => !q || name.toLowerCase().includes(q))
    .map(([name, d]) => ({
      name, address: d.address,
      count:    d.invoices.length,
      sales:    d.invoices.reduce((s, i) => s + i.invoiceTotal, 0),
      gross:    d.invoices.reduce((s, i) => s + (i.grossProfit || 0), 0),
      delivery: d.invoices.reduce((s, i) => s + (i.delivery    || 0), 0),
      net:      d.invoices.reduce((s, i) => s + (i.netProfit   || 0), 0),
      lastDate: d.invoices.map(i => i.date).sort().reverse()[0],
    }))
    .sort((a, b) => b.sales - a.sales);

  const tbody = document.getElementById('customerBody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><p>No customers found.</p></div></td></tr>'; return; }
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
  const custInvoices = invoices.filter(i => i.customer === name);
  const address = custInvoices.find(i => i.address)?.address || '';
  const sales    = custInvoices.reduce((s, i) => s + i.invoiceTotal, 0);
  const gross    = custInvoices.reduce((s, i) => s + (i.grossProfit || 0), 0);
  const delivery = custInvoices.reduce((s, i) => s + (i.delivery    || 0), 0);
  const net      = custInvoices.reduce((s, i) => s + (i.netProfit   || 0), 0);

  set('detailName',    name);
  set('detailAddress', address);
  document.getElementById('detailKPIs').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Total Sales</div><div class="kpi-value">${fmt(sales)}</div><div class="kpi-sub">${custInvoices.length} invoices</div></div>
    <div class="kpi-card"><div class="kpi-label">Gross Profit</div><div class="kpi-value positive">${fmt(gross)}</div><div class="kpi-sub">${pct(sales > 0 ? gross/sales : 0)} margin</div></div>
    <div class="kpi-card"><div class="kpi-label">Delivery Cost</div><div class="kpi-value">${fmt(delivery)}</div><div class="kpi-sub">${pct(sales > 0 ? delivery/sales : 0)} of sales</div></div>
    <div class="kpi-card"><div class="kpi-label">Net Profit</div><div class="kpi-value ${net >= 0 ? 'positive' : 'negative'}">${fmt(net)}</div><div class="kpi-sub">${pct(sales > 0 ? net/sales : 0)} margin</div></div>
  `;
  document.getElementById('detailInvoices').innerHTML = [...custInvoices]
    .sort((a, b) => (b.date > a.date ? 1 : -1))
    .map(inv => {
      const gp = inv.invoiceTotal > 0 ? inv.grossProfit / inv.invoiceTotal : 0;
      const np = inv.invoiceTotal > 0 ? inv.netProfit   / inv.invoiceTotal : 0;
      return `<tr>
        <td><strong>${inv.invNo}</strong></td><td>${inv.date}</td>
        <td>${courierPill(inv.courier)}</td>
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
  const m = address.match(/([A-Za-z\s]+),?\s+TX\s+\d{5}/i);
  if (m) return m[1].trim();
  const m2 = address.match(/([A-Za-z\s]+)\s+TX/i);
  if (m2) return m2[1].trim();
  return 'Unknown';
}

function renderAreasTab(filtered) {
  filtered = filtered || filterInvoices();
  const map = {};
  filtered.forEach(inv => {
    const city = parseCity(inv.address);
    if (!map[city]) map[city] = { count: 0, sales: 0, gross: 0, delivery: 0, net: 0 };
    map[city].count++;
    map[city].sales    += inv.invoiceTotal;
    map[city].gross    += inv.grossProfit || 0;
    map[city].delivery += inv.delivery    || 0;
    map[city].net      += inv.netProfit   || 0;
  });
  const rows = Object.entries(map).sort((a, b) => b[1].net - a[1].net);

  const totalDel   = filtered.reduce((s, i) => s + (i.delivery || 0), 0);
  const bestArea   = rows[0];
  const highDel    = [...rows].sort((a, b) => (b[1].delivery/b[1].count) - (a[1].delivery/a[1].count))[0];
  document.getElementById('areasKPIs').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Areas Served</div><div class="kpi-value">${rows.length}</div><div class="kpi-sub">${rows.filter(([,d]) => d.net >= 0).length} profitable</div></div>
    <div class="kpi-card"><div class="kpi-label">Most Profitable</div><div class="kpi-value" style="font-size:18px">${bestArea ? bestArea[0] : '—'}</div><div class="kpi-sub">${bestArea ? fmt(bestArea[1].net) + ' net' : ''}</div></div>
    <div class="kpi-card"><div class="kpi-label">Highest Avg Delivery</div><div class="kpi-value" style="font-size:18px">${highDel ? highDel[0] : '—'}</div><div class="kpi-sub">${highDel ? fmt(highDel[1].delivery / highDel[1].count) + ' avg' : ''}</div></div>
    <div class="kpi-card"><div class="kpi-label">Total Delivery Spend</div><div class="kpi-value">${fmt(totalDel)}</div><div class="kpi-sub">across all areas</div></div>
  `;
  const tbody = document.getElementById('areasBody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><p>No area data yet.</p></div></td></tr>'; return; }
  tbody.innerHTML = rows.map(([city, d], ri) => {
    const gp     = d.sales > 0 ? d.gross    / d.sales : 0;
    const np     = d.sales > 0 ? d.net      / d.sales : 0;
    const avgDel = d.count > 0 ? d.delivery / d.count : 0;
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

// ── COURIERS TAB ──────────────────────────────────────────────────
function renderCouriersTab(filtered) {
  filtered = filtered || filterInvoices();
  const COURIERS = ['Dropoff', 'Xpress Courierz'];
  const map = {};
  filtered.forEach(inv => {
    const c = inv.courier || 'Unassigned';
    if (!map[c]) map[c] = { count: 0, cost: 0, sales: 0, net: 0 };
    map[c].count++;
    map[c].cost  += inv.delivery    || 0;
    map[c].sales += inv.invoiceTotal || 0;
    map[c].net   += inv.netProfit   || 0;
  });

  const totalCost = filtered.reduce((s, i) => s + (i.delivery || 0), 0);
  const totalRuns = filtered.length;

  // KPIs
  document.getElementById('courierKPIs').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Total Courier Spend</div><div class="kpi-value">${fmt(totalCost)}</div><div class="kpi-sub">${totalRuns} deliveries</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg Cost per Delivery</div><div class="kpi-value">${totalRuns > 0 ? fmt(totalCost / totalRuns) : '—'}</div><div class="kpi-sub">across both couriers</div></div>
    <div class="kpi-card"><div class="kpi-label">Dropoff Spend</div><div class="kpi-value">${fmt((map['Dropoff']||{cost:0}).cost)}</div><div class="kpi-sub">${map['Dropoff'] ? map['Dropoff'].count + ' runs' : '0 runs'}</div></div>
    <div class="kpi-card"><div class="kpi-label">Xpress Courierz Spend</div><div class="kpi-value">${fmt((map['Xpress Courierz']||{cost:0}).cost)}</div><div class="kpi-sub">${map['Xpress Courierz'] ? map['Xpress Courierz'].count + ' runs' : '0 runs'}</div></div>
  `;

  // Courier cards
  const dropoff = map['Dropoff']       || { count: 0, cost: 0, sales: 0, net: 0 };
  const xpress  = map['Xpress Courierz'] || { count: 0, cost: 0, sales: 0, net: 0 };
  const dropPct = totalCost > 0 ? (dropoff.cost / totalCost) * 100 : 0;
  const xpsPct  = totalCost > 0 ? (xpress.cost  / totalCost) * 100 : 0;

  document.getElementById('courierCards').innerHTML = `
    <div class="courier-card">
      <div class="courier-card-header">
        <div class="courier-card-name">Dropoff</div>
        <span class="courier-badge courier-badge-dropoff">${dropPct.toFixed(0)}% of spend</span>
      </div>
      <div class="courier-stats">
        <div><div class="courier-stat-label">Total Cost</div><div class="courier-stat-value">${fmt(dropoff.cost)}</div></div>
        <div><div class="courier-stat-label">Deliveries</div><div class="courier-stat-value">${dropoff.count}</div></div>
        <div><div class="courier-stat-label">Avg per Run</div><div class="courier-stat-value">${dropoff.count > 0 ? fmt(dropoff.cost / dropoff.count) : '—'}</div></div>
      </div>
      <div class="courier-bar-wrap"><div class="courier-bar-fill bar-dropoff" style="width:${dropPct}%"></div></div>
    </div>
    <div class="courier-card">
      <div class="courier-card-header">
        <div class="courier-card-name">Xpress Courierz</div>
        <span class="courier-badge courier-badge-xpress">${xpsPct.toFixed(0)}% of spend</span>
      </div>
      <div class="courier-stats">
        <div><div class="courier-stat-label">Total Cost</div><div class="courier-stat-value">${fmt(xpress.cost)}</div></div>
        <div><div class="courier-stat-label">Deliveries</div><div class="courier-stat-value">${xpress.count}</div></div>
        <div><div class="courier-stat-label">Avg per Run</div><div class="courier-stat-value">${xpress.count > 0 ? fmt(xpress.cost / xpress.count) : '—'}</div></div>
      </div>
      <div class="courier-bar-wrap"><div class="courier-bar-fill bar-xpress" style="width:${xpsPct}%"></div></div>
    </div>
  `;

  // Detail table
  const rows = Object.entries(map).sort((a, b) => b[1].cost - a[1].cost);
  const tbody = document.getElementById('courierBody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><p>No courier data yet.</p></div></td></tr>'; return; }
  tbody.innerHTML = rows.map(([name, d]) => {
    const share = totalCost > 0 ? d.cost / totalCost : 0;
    const np    = d.sales  > 0 ? d.net  / d.sales   : 0;
    return `<tr>
      <td>${courierPill(name)}</td>
      <td class="num">${d.count}</td>
      <td class="num mono" style="color:var(--accent)">${fmt(d.cost)}</td>
      <td class="num mono">${d.count > 0 ? fmt(d.cost / d.count) : '—'}</td>
      <td class="num mono">${pct(share)}</td>
      <td class="num mono">${fmt(d.sales)}</td>
      <td class="num mono" style="color:${d.net >= 0 ? 'var(--profit)' : 'var(--loss)'};font-weight:600">${fmt(d.net)}</td>
      <td class="num"><span class="badge ${d.net >= 0 ? 'badge-profit' : 'badge-loss'}">${pct(np)}</span></td>
    </tr>`;
  }).join('');
}

// ── PDF EXPORT ────────────────────────────────────────────────────
async function generatePDF() {
  const filtered = filterInvoices();
  if (!filtered.length) { showToast('No invoices to export.'); return; }
  showToast('Generating PDF…');

  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  const doc  = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);

  const GREEN  = rgb(0.10, 0.29, 0.23);
  const ACCENT = rgb(0.79, 0.38, 0.16);
  const MUTED  = rgb(0.42, 0.42, 0.42);
  const PROFIT = rgb(0.10, 0.42, 0.23);
  const LOSS   = rgb(0.72, 0.20, 0.20);
  const BLACK  = rgb(0.07, 0.07, 0.07);
  const RULE   = rgb(0.88, 0.88, 0.85);

  const W = 612, H = 792, M = 44;
  const now = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

  const totalSales    = filtered.reduce((s, i) => s + i.invoiceTotal, 0);
  const totalGross    = filtered.reduce((s, i) => s + (i.grossProfit || 0), 0);
  const totalDelivery = filtered.reduce((s, i) => s + (i.delivery    || 0), 0);
  const totalNet      = filtered.reduce((s, i) => s + (i.netProfit   || 0), 0);

  function newPage() {
    const p = doc.addPage([W, H]);
    p.drawRectangle({ x: 0, y: H - 68, width: W, height: 68, color: GREEN });
    p.drawText('cambie', { x: M, y: H - 40, size: 20, font: bold, color: rgb(1,1,1) });
    p.drawText('Local Delivery P&L Report', { x: M, y: H - 57, size: 9, font: reg, color: rgb(1,1,1,0.7) });
    p.drawText('Generated: ' + now, { x: W - M - 110, y: H - 40, size: 8, font: reg, color: rgb(1,1,1,0.65) });
    p.drawText('Cambie Inc. · 10630 Newkirk St, Ste 100, Dallas TX 75220 · Confidential', { x: M, y: 22, size: 7, font: reg, color: MUTED });
    return { p, y: H - 84 };
  }
  function secTitle(ctx, title) {
    if (ctx.y < 100) ctx = newPage();
    ctx.p.drawText(title, { x: M, y: ctx.y, size: 8, font: bold, color: MUTED });
    ctx.y -= 4;
    ctx.p.drawLine({ start: { x: M, y: ctx.y }, end: { x: W - M, y: ctx.y }, thickness: 0.5, color: RULE });
    ctx.y -= 14; return ctx;
  }
  function tHead(ctx, cols) {
    ctx.p.drawRectangle({ x: M, y: ctx.y - 14, width: W - M*2, height: 18, color: rgb(0.95,0.94,0.92) });
    cols.forEach(col => {
      const lw = bold.widthOfTextAtSize(col.label, 7);
      const tx = col.align === 'right' ? col.x + col.w - lw : col.x + 3;
      ctx.p.drawText(col.label, { x: tx, y: ctx.y - 10, size: 7, font: bold, color: MUTED });
    });
    ctx.y -= 18; return ctx;
  }
  function tRow(ctx, cols, vals, colors, ri) {
    if (ctx.y < 60) ctx = newPage();
    if (ri % 2 === 0) ctx.p.drawRectangle({ x: M, y: ctx.y - 13, width: W - M*2, height: 16, color: rgb(0.99,0.99,0.98) });
    cols.forEach((col, ci) => {
      const v  = vals[ci]; const vw = reg.widthOfTextAtSize(v, 8);
      const tx = col.align === 'right' ? col.x + col.w - vw : col.x + 3;
      ctx.p.drawText(v, { x: tx, y: ctx.y - 10, size: 8, font: ci === 0 ? bold : reg, color: colors[ci] || BLACK });
    });
    ctx.p.drawLine({ start: { x: M, y: ctx.y - 14 }, end: { x: W - M, y: ctx.y - 14 }, thickness: 0.3, color: RULE });
    ctx.y -= 16; return ctx;
  }

  let ctx = newPage();
  // KPI boxes
  const kpiBoxW = (W - M*2 - 9) / 4;
  const kpis = [
    { label: 'TOTAL SALES',      value: fmtPDF(totalSales),    sub: filtered.length + ' invoices' },
    { label: 'GROSS PROFIT',     value: fmtPDF(totalGross),    sub: pct(totalSales > 0 ? totalGross/totalSales : 0) + ' margin' },
    { label: 'DELIVERY EXPENSE', value: fmtPDF(totalDelivery), sub: pct(totalSales > 0 ? totalDelivery/totalSales : 0) + ' of sales' },
    { label: 'NET PROFIT',       value: fmtPDF(totalNet),      sub: pct(totalSales > 0 ? totalNet/totalSales : 0) + ' margin' },
  ];
  kpis.forEach((k, i) => {
    const bx = M + i * (kpiBoxW + 3);
    ctx.p.drawRectangle({ x: bx, y: ctx.y - 56, width: kpiBoxW, height: 60, color: rgb(0.97,0.96,0.95), borderColor: RULE, borderWidth: 0.5 });
    ctx.p.drawText(k.label, { x: bx + 9, y: ctx.y - 14, size: 7, font: bold, color: MUTED });
    const vc = i === 3 ? (totalNet >= 0 ? PROFIT : LOSS) : BLACK;
    ctx.p.drawText(k.value, { x: bx + 9, y: ctx.y - 30, size: 14, font: bold, color: vc });
    ctx.p.drawText(k.sub,   { x: bx + 9, y: ctx.y - 45, size: 8,  font: reg,  color: MUTED });
  });
  ctx.y -= 72;

  // Invoice table
  ctx = secTitle(ctx, 'INVOICE DETAIL');
  const invCols = [
    { label: 'Invoice',      x: M,     w: 64,  align: 'left'  },
    { label: 'Customer',     x: M+64,  w: 90,  align: 'left'  },
    { label: 'Date',         x: M+154, w: 56,  align: 'left'  },
    { label: 'Courier',      x: M+210, w: 76,  align: 'left'  },
    { label: 'Sales',        x: M+286, w: 58,  align: 'right' },
    { label: 'Gross',        x: M+344, w: 56,  align: 'right' },
    { label: 'GP%',          x: M+400, w: 30,  align: 'right' },
    { label: 'Delivery',     x: M+430, w: 52,  align: 'right' },
    { label: 'Net',          x: M+482, w: 52,  align: 'right' },
    { label: 'Net%',         x: M+534, w: 30,  align: 'right' },
  ];
  ctx = tHead(ctx, invCols);
  filtered.forEach((inv, ri) => {
    const gpP = inv.invoiceTotal > 0 ? inv.grossProfit / inv.invoiceTotal : 0;
    const npP = inv.invoiceTotal > 0 ? inv.netProfit   / inv.invoiceTotal : 0;
    ctx = tRow(ctx, invCols,
      [inv.invNo, inv.customer, inv.date, inv.courier || '—', fmtPDF(inv.invoiceTotal), fmtPDF(inv.grossProfit), pct(gpP), fmtPDF(inv.delivery), fmtPDF(inv.netProfit), pct(npP)],
      [BLACK, BLACK, BLACK, BLACK, BLACK, PROFIT, MUTED, ACCENT, inv.netProfit >= 0 ? PROFIT : LOSS, MUTED], ri);
  });
  ctx.y -= 8;

  // Courier summary
  const cmap = {};
  filtered.forEach(inv => {
    const c = inv.courier || 'Unassigned';
    if (!cmap[c]) cmap[c] = { count: 0, cost: 0, sales: 0, net: 0 };
    cmap[c].count++; cmap[c].cost += inv.delivery || 0; cmap[c].sales += inv.invoiceTotal; cmap[c].net += inv.netProfit || 0;
  });
  ctx = secTitle(ctx, 'COURIER SUMMARY');
  const cCols = [
    { label: 'Courier',       x: M,     w: 120, align: 'left'  },
    { label: 'Deliveries',    x: M+120, w: 60,  align: 'right' },
    { label: 'Total Cost',    x: M+180, w: 72,  align: 'right' },
    { label: 'Avg per Run',   x: M+252, w: 72,  align: 'right' },
    { label: '% of Spend',    x: M+324, w: 60,  align: 'right' },
    { label: 'Assoc. Sales',  x: M+384, w: 72,  align: 'right' },
    { label: 'Net Profit',    x: M+456, w: 72,  align: 'right' },
    { label: 'Net%',          x: M+528, w: 36,  align: 'right' },
  ];
  ctx = tHead(ctx, cCols);
  Object.entries(cmap).sort((a,b) => b[1].cost - a[1].cost).forEach(([name, d], ri) => {
    const share = totalDelivery > 0 ? d.cost / totalDelivery : 0;
    const np = d.sales > 0 ? d.net / d.sales : 0;
    ctx = tRow(ctx, cCols, [name, String(d.count), fmtPDF(d.cost), d.count > 0 ? fmtPDF(d.cost/d.count) : '—', pct(share), fmtPDF(d.sales), fmtPDF(d.net), pct(np)],
      [BLACK, BLACK, ACCENT, MUTED, MUTED, BLACK, d.net >= 0 ? PROFIT : LOSS, MUTED], ri);
  });

  const bytes = await doc.save();
  const blob  = new Blob([bytes], { type: 'application/pdf' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url; a.download = 'Cambie_Delivery_PL_' + now.replace(/,?\s+/g, '_') + '.pdf';
  a.click(); URL.revokeObjectURL(url);
  showToast('PDF exported ✓');
}

// ── HELPERS ───────────────────────────────────────────────────────
function courierPill(name) {
  if (!name) return '<span class="courier-pill courier-pill-none">—</span>';
  const cls = name === 'Dropoff' ? 'courier-pill-dropoff' : name === 'Xpress Courierz' ? 'courier-pill-xpress' : 'courier-pill-none';
  return `<span class="courier-pill ${cls}">${name}</span>`;
}

function fmt(n)    { return '$' + (n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtPDF(n) { return '$' + (n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function pct(n)    { return ((n||0)*100).toFixed(1) + '%'; }
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function cls(id, c) { const el = document.getElementById(id); if (el) el.className   = c; }

function setSyncStatus(state, label) {
  document.getElementById('syncDot').className    = 'sync-dot ' + state;
  document.getElementById('syncLabel').textContent = label;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}
