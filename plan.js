// GET /api/plan?g=11A1[&debug=1] -> { group, updated, events:[{id,date,s,e,name,type,room,teacher,sub}] }
// Parser pod Plansoft.org (podzial.mech.pk.edu.pl): 1 tabela na dzień, kolumny = tygodnie, wiersze = sloty 45 min, rowspan = długość zajęć.
import { parse as H } from 'node-html-parser';

const BASE = 'http://podzial.mech.pk.edu.pl/stacjonarne/html/';
const ROM = { I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9, X:10, XI:11, XII:12 };
const TIME = /^(\d{1,2})\.(\d{2})\s*-\s*(\d{1,2})\.(\d{2})$/, DATE = /^(\d{1,2})\s+(XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)$/;
const TITLE = /^(dr|mgr|mg|inż\.?|hab\.?|prof\.?|n\.|med\.|sztuki|arch\.?)$/i;
const clean = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&[a-z]+;/gi, ' ');
const lines = el => clean(el.innerHTML.replace(/<br\s*\/?>|<\/(p|div|li|tr|b|strong|a|span|font|i)>/gi, '\n').replace(/<[^>]+>/g, ''))
  .split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
const txt = el => lines(el).join(' ');
const pad = n => String(n).padStart(2, '0');

function grid(table) {
  const occ = {};
  return table.querySelectorAll('tr').map((tr, r) => {
    let c = 0; const cells = [];
    for (const td of tr.querySelectorAll('td,th')) {
      while (occ[r + ':' + c]) c++;
      const rs = +td.getAttribute('rowspan') || 1, cs = +td.getAttribute('colspan') || 1;
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) occ[(r + i) + ':' + (c + j)] = 1;
      cells.push({ td, r, c, rs, cs }); c += cs;
    }
    return cells;
  });
}

export function parsePlan(html) {
  const root = H(html), all = root.text;
  const sem = /Semestr\s+(zimowy|letni)\s+(\d{4})\/(\d{4})/i.exec(all) || [0, 'zimowy', 2026, 2027];
  const year = m => /letni/i.test(sem[1]) ? +sem[3] : (m >= 9 ? +sem[2] : +sem[3]);
  const names = {}, teachers = {}, raw = [];
  let dates = null;

  const legend = x => {
    const L = lines(x.td); if (L.length < 2 || x.td.querySelector('a')) return;
    if (/^\S+ \d+$/.test(L[1])) { // legenda prowadzącego: "WyDo / W 14 / dr inż. Wyszyński Dominik"
      const full = L.slice(2).join(' '); if (!full) return;
      const key = full.split(' ').filter(w => !TITLE.test(w)).join(' ').toUpperCase();
      teachers[key] = full;
    } else if (/^[A-Za-z0-9_]{4,}$/.test(L[0])) names[L[0]] = L.slice(1).join(' '); // legenda przedmiotu
  };

  for (const t of root.querySelectorAll('table').filter(t => !t.querySelector('table'))) {
    const rows = grid(t), slotAt = {};
    rows.forEach((cells, r) => {
      const tc = cells.find(x => TIME.test(txt(x.td)));
      if (tc) { const m = TIME.exec(txt(tc.td)); slotAt[r] = [`${+m[1]}:${m[2]}`, `${+m[3]}:${m[4]}`]; }
    });
    rows.forEach((cells, r) => {
      const ds = cells.filter(x => DATE.test(txt(x.td)));
      if (ds.length >= 3) {
        dates = ds.map(x => { const m = DATE.exec(txt(x.td)), mo = ROM[m[2]]; return `${year(mo)}-${pad(mo)}-${pad(+m[1])}`; });
        const end = ds[ds.length - 1].c + ds[ds.length - 1].cs;
        cells.filter(x => x.c >= end).forEach(legend);
        return;
      }
      const tc = cells.find(x => TIME.test(txt(x.td)));
      if (!tc || !dates) return;
      const off = tc.c + tc.cs;
      for (const x of cells) {
        if (x === tc) continue;
        const idx = x.c - off, L = lines(x.td);
        if (!L.length) continue;
        if (idx >= dates.length) { legend(x); continue; }
        if (idx < 0 || /^Brak zajęć$/i.test(L.join(' '))) continue;
        const links = x.td.querySelectorAll('a').map(a => txt(a));
        const type = /^e-?learning/i.test(L[1] || '') ? 'E' : (L[1] || '?')[0].toUpperCase();
        const grp = L.slice(2).filter(s => !links.includes(s)).join(' ');
        const sg = /GK\/P\s?0?(\d+)/i.exec(grp);
        raw.push({
          date: dates[idx], s: slotAt[r][0], e: (slotAt[r + x.rs - 1] || slotAt[r])[1], abbr: L[0], type,
          room: links.find(s => /\d/.test(s)) || '', tch: links.find(s => !/\d/.test(s)) || '',
          sub: sg ? `GK/P ${pad(+sg[1])}` : '',
        });
      }
    });
  }
  const events = raw.map((e, i) => ({
    id: i + 1, date: e.date, s: e.s, e: e.e, name: names[e.abbr] || e.abbr, type: e.type, room: e.room,
    teacher: teachers[e.tch.toUpperCase()] || e.tch, sub: e.sub,
  }));
  const upd = /Data aktualizacji:\s*([\d.]+\s+[\d:]+)/.exec(all);
  return { events, updated: upd ? upd[1] : '', names };
}

async function getHtml(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('PK HTTP ' + r.status);
  const b = Buffer.from(await r.arrayBuffer());
  let s = b.toString('utf8'); if (s.includes('\ufffd')) s = new TextDecoder('windows-1250').decode(b);
  return s;
}

export default async function handler(req, res) {
  const g = String(req.query.g || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!g) return res.status(400).json({ error: 'brak grupy' });
  try {
    const p = parsePlan(await getHtml(`${BASE}${g}.htm`));
    if (req.query.debug) return res.json({ n: p.events.length, sample: p.events.slice(0, 5), names: p.names, updated: p.updated });
    if (!p.events.length) throw new Error('parser nie znalazł zajęć');
    res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate');
    res.json({ group: g, updated: p.updated, events: p.events });
  } catch (e) { res.status(502).json({ group: g, error: String(e.message || e), events: [] }); }
}
