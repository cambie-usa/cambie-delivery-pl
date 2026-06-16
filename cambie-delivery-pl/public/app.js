// =================================================================
// app.js — Supabase client + data layer
// =================================================================

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── CRUD ──────────────────────────────────────────────────────────

async function loadInvoices() {
  const { data, error } = await db
    .from('invoices')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function upsertInvoice(inv) {
  const row = {
    inv_no:        inv.invNo,
    customer:      inv.customer,
    address:       inv.address || '',
    courier:       inv.courier || '',
    inv_date:      inv.date,
    invoice_total: inv.invoiceTotal,
    gross_profit:  inv.grossProfit,
    delivery:      inv.delivery,
    net_profit:    inv.netProfit,
    items:         inv.items,
  };

  const { data, error } = await db
    .from('invoices')
    .upsert(row, { onConflict: 'inv_no' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function dbDeleteInvoice(invNo) {
  const { error } = await db
    .from('invoices')
    .delete()
    .eq('inv_no', invNo);
  if (error) throw error;
}

// ── NORMALISE DB ROW → APP OBJECT ────────────────────────────────

function rowToInv(row) {
  return {
    id:           row.id,
    invNo:        row.inv_no,
    customer:     row.customer,
    address:      row.address || '',
    courier:      row.courier || '',
    date:         row.inv_date,
    invoiceTotal: parseFloat(row.invoice_total),
    grossProfit:  parseFloat(row.gross_profit),
    delivery:     parseFloat(row.delivery),
    netProfit:    parseFloat(row.net_profit),
    items:        row.items || [],
  };
}
