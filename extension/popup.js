/* Harpe popup — hands the query/URL to the Harpe site, which resolves it
   (museum search · page scan · gigapixel · X video · cobalt media). No backend
   logic duplicated here. */
const DEFAULT_BASE = 'https://harpe-site.vercel.app';
const $ = (id) => document.getElementById(id);

async function getBase() {
  const { harpeBase } = await chrome.storage.sync.get('harpeBase');
  return (harpeBase || DEFAULT_BASE).replace(/\/$/, '');
}

async function open(query) {
  const q = (query || '').trim();
  if (!q) return;
  const base = await getBase();
  await chrome.tabs.create({ url: `${base}/?q=${encodeURIComponent(q)}` });
  window.close();
}

document.addEventListener('DOMContentLoaded', async () => {
  const input = $('q');
  input.focus();
  $('base').value = (await chrome.storage.sync.get('harpeBase')).harpeBase || '';

  $('go').addEventListener('click', () => open(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(input.value); });

  $('tab').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) open(tab.url);
  });

  $('gear').addEventListener('click', () => $('settings').classList.toggle('open'));
  $('base').addEventListener('change', async (e) => {
    const v = e.target.value.trim();
    if (v) await chrome.storage.sync.set({ harpeBase: v });
    else await chrome.storage.sync.remove('harpeBase');
  });
});
