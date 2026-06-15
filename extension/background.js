/* Harpe background — right-click context menus that send a link/image/video/page
   to the Harpe site for resolution + download. */
const DEFAULT_BASE = 'https://harpe-site.vercel.app';

async function base() {
  const { harpeBase } = await chrome.storage.sync.get('harpeBase');
  return (harpeBase || DEFAULT_BASE).replace(/\/$/, '');
}
async function openHarpe(q) {
  if (!q) return;
  chrome.tabs.create({ url: `${await base()}/?q=${encodeURIComponent(q)}` });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'harpe-page', title: 'Harpe: grab media from this page', contexts: ['page', 'frame'] });
    chrome.contextMenus.create({ id: 'harpe-link', title: 'Harpe: grab this link', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'harpe-media', title: 'Harpe: grab this image/video', contexts: ['image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'harpe-sel', title: 'Harpe: search “%s”', contexts: ['selection'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'harpe-link' && info.linkUrl) openHarpe(info.linkUrl);
  else if (info.menuItemId === 'harpe-media' && (info.srcUrl)) openHarpe(info.srcUrl);
  else if (info.menuItemId === 'harpe-sel' && info.selectionText) openHarpe(info.selectionText);
  else if (info.menuItemId === 'harpe-page') openHarpe(info.pageUrl || tab?.url || '');
});
