const field = document.querySelector('input');
chrome.storage.local.get('port').then(({port = 8787}) => { field.value = port; });
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault();
  await chrome.storage.local.set({port:field.valueAsNumber});
  document.querySelector('output').textContent = '已保存';
});
