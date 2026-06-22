/**
 * Mermaid-js loader
 */

const MERMAID = 'mermaid';
const PREVIEW_BUTTON = 'mermaid-preview-trigger';
const PREVIEW_DIALOG = 'mermaid-preview-dialog';
const PREVIEW_BODY = 'mermaid-preview-body';
const PREVIEW_SCALE_STEP = 0.2;
const PREVIEW_MIN_SCALE = 0.6;
const PREVIEW_MAX_SCALE = 2.4;
const themeMapper = Theme.getThemeMapper('default', 'dark');

let previewDialog = null;
let previewScale = 1;
let observer = null;

function closePreview() {
  if (previewDialog && previewDialog.open) {
    previewDialog.close();
  }
}

function setPreviewScale(scale) {
  previewScale = Math.min(PREVIEW_MAX_SCALE, Math.max(PREVIEW_MIN_SCALE, scale));

  if (previewDialog) {
    previewDialog
      .querySelector(`.${PREVIEW_BODY}`)
      .style.setProperty('--mermaid-preview-scale', previewScale);
  }
}

function handlePreviewAction(event) {
  const button = event.target.closest('[data-mermaid-preview-action]');

  if (button === null) {
    return;
  }

  switch (button.dataset.mermaidPreviewAction) {
    case 'zoom-out':
      setPreviewScale(previewScale - PREVIEW_SCALE_STEP);
      break;
    case 'zoom-in':
      setPreviewScale(previewScale + PREVIEW_SCALE_STEP);
      break;
    case 'reset':
      setPreviewScale(1);
      break;
    case 'close':
      closePreview();
      break;
  }
}

function getPreviewDialog() {
  if (previewDialog) {
    return previewDialog;
  }

  previewDialog = document.createElement('dialog');
  previewDialog.className = PREVIEW_DIALOG;
  previewDialog.innerHTML = `
    <div class="mermaid-preview-panel">
      <div class="mermaid-preview-toolbar" aria-label="流程图预览工具">
        <button type="button" data-mermaid-preview-action="zoom-out" aria-label="缩小">
          <i class="fas fa-search-minus"></i>
        </button>
        <button type="button" data-mermaid-preview-action="zoom-in" aria-label="放大">
          <i class="fas fa-search-plus"></i>
        </button>
        <button type="button" data-mermaid-preview-action="reset" aria-label="还原">
          <i class="fas fa-rotate-left"></i>
        </button>
        <button type="button" data-mermaid-preview-action="close" aria-label="关闭预览">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="mermaid-preview-viewport">
        <div class="${PREVIEW_BODY}"></div>
      </div>
    </div>
  `;

  previewDialog.addEventListener('click', (event) => {
    if (event.target === previewDialog) {
      closePreview();
    }
  });

  previewDialog
    .querySelector('.mermaid-preview-toolbar')
    .addEventListener('click', handlePreviewAction);

  document.body.appendChild(previewDialog);
  return previewDialog;
}

function openPreview(elem) {
  const svg = elem.querySelector('svg');

  if (svg === null) {
    return;
  }

  const dialog = getPreviewDialog();
  const body = dialog.querySelector(`.${PREVIEW_BODY}`);
  const clonedSvg = svg.cloneNode(true);

  setPreviewScale(1);
  body.replaceChildren(clonedSvg);
  dialog.showModal();
}

function createPreviewButton(elem) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = PREVIEW_BUTTON;
  button.setAttribute('aria-label', '放大预览流程图');
  button.innerHTML = '<i class="fas fa-expand"></i>';
  button.addEventListener('click', () => openPreview(elem));
  return button;
}

function enhanceMermaid(elem) {
  if (elem.querySelector('svg') === null) {
    return;
  }

  elem.setAttribute('role', 'button');
  elem.setAttribute('tabindex', '0');
  elem.setAttribute('aria-label', '点击放大预览流程图');

  if (
    elem.nextElementSibling === null ||
    !elem.nextElementSibling.classList.contains(PREVIEW_BUTTON)
  ) {
    elem.after(createPreviewButton(elem));
  }

  if (elem.dataset.previewReady === 'true') {
    return;
  }

  elem.dataset.previewReady = 'true';
  elem.addEventListener('click', () => openPreview(elem));
  elem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPreview(elem);
    }
  });
}

function enhanceAllMermaid() {
  [...document.getElementsByClassName(MERMAID)].forEach(enhanceMermaid);
}

function watchMermaidRender() {
  if (observer !== null) {
    return;
  }

  observer = new MutationObserver(enhanceAllMermaid);
  [...document.getElementsByClassName(MERMAID)].forEach((elem) => {
    observer.observe(elem, { childList: true, subtree: true });
  });
}

function refreshTheme(event) {
  if (event.source === window && event.data && event.data.id === Theme.ID) {
    // Re-render the SVG › <https://github.com/mermaid-js/mermaid/issues/311#issuecomment-332557344>
    const mermaidList = document.getElementsByClassName(MERMAID);

    [...mermaidList].forEach((elem) => {
      const svgCode = elem.previousSibling.children.item(0).textContent;
      elem.textContent = svgCode;
      elem.removeAttribute('data-processed');
    });

    const newTheme = themeMapper[Theme.visualState];

    mermaid.initialize({ theme: newTheme });
    mermaid.init(null, `.${MERMAID}`);
    enhanceAllMermaid();
  }
}

function setNode(elem) {
  const svgCode = elem.textContent;
  const backup = elem.parentElement;
  backup.classList.add('d-none');
  // Create mermaid node
  const mermaid = document.createElement('pre');
  mermaid.classList.add(MERMAID);
  const text = document.createTextNode(svgCode);
  mermaid.appendChild(text);
  backup.after(mermaid);
}

export function loadMermaid() {
  if (
    typeof mermaid === 'undefined' ||
    typeof mermaid.initialize !== 'function'
  ) {
    return;
  }

  const initTheme = themeMapper[Theme.visualState];

  let mermaidConf = {
    theme: initTheme
  };

  const basicList = document.getElementsByClassName('language-mermaid');
  [...basicList].forEach(setNode);

  mermaid.initialize(mermaidConf);
  watchMermaidRender();
  enhanceAllMermaid();

  if (Theme.switchable) {
    window.addEventListener('message', refreshTheme);
  }
}
