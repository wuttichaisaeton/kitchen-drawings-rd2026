(function() {
  'use strict';

  let currentSimMode = 'ai'; // Default to our AI version

  // Hijack window.kdSimBend3D
  let originalKdSimBend3D = window.kdSimBend3D;
  Object.defineProperty(window, 'kdSimBend3D', {
    get: function() {
      return (currentSimMode === 'ai' && window.kdSimBend3D_AI) ? window.kdSimBend3D_AI : originalKdSimBend3D;
    },
    set: function(val) {
      originalKdSimBend3D = val;
    },
    configurable: true
  });

  // Watch for DOM changes to inject our UI
  const observer = new MutationObserver((mutations) => {
    const ctrls = document.querySelector('.sb-sim-ctrls');
    if (ctrls && !ctrls.querySelector('.sb-sim-mode-toggle')) {
      injectToggle(ctrls);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function injectToggle(parent) {
    return; // เอ๋ 2026-06-08: ไม่ต้องขึ้นปุ่ม Antigravity (AI) — AI engine เปิดอยู่ตลอด (currentSimMode='ai')
    const container = document.createElement('div');
    container.className = 'sb-sim-mode-toggle';
    container.style.cssText = `
      display: inline-flex;
      align-items: center;
      margin-left: 20px;
      gap: 4px;
      background: rgba(12, 19, 27, 0.08);
      padding: 3px;
      border-radius: 6px;
      border: 1px solid rgba(12, 19, 27, 0.05);
    `;

    const label = document.createElement('span');
    label.innerText = 'SIM VERSION:';
    label.style.cssText = `
      font-family: "Flux Architect", monospace;
      font-size: 10px;
      color: rgba(12, 19, 27, 0.5);
      margin-right: 4px;
      font-weight: bold;
    `;
    container.appendChild(label);

    const btnStandard = document.createElement('button');
    btnStandard.type = 'button';
    btnStandard.innerText = 'Standard';
    btnStandard.style.cssText = getBtnStyle(currentSimMode === 'standard');
    btnStandard.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode('standard');
    });

    const btnAI = document.createElement('button');
    btnAI.type = 'button';
    btnAI.innerText = 'Antigravity (AI)';
    btnAI.style.cssText = getBtnStyle(currentSimMode === 'ai', true);
    btnAI.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode('ai');
    });

    container.appendChild(btnStandard);
    container.appendChild(btnAI);
    parent.appendChild(container);
  }

  function getBtnStyle(isActive, isAI) {
    if (isActive) {
      return `
        border: none !important;
        padding: 4px 10px !important;
        border-radius: 4px !important;
        font-family: "Flux Architect", monospace !important;
        font-size: 11px !important;
        font-weight: bold !important;
        cursor: pointer !important;
        background: ${isAI ? '#e8923a' : '#737d88'} !important;
        color: #ffffff !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.15) !important;
      `;
    }
    return `
      border: none !important;
      padding: 4px 10px !important;
      border-radius: 4px !important;
      font-family: "Flux Architect", monospace !important;
      font-size: 11px !important;
      cursor: pointer !important;
      background: transparent !important;
      color: rgba(12, 19, 27, 0.6) !important;
    `;
  }

  function setMode(mode) {
    if (currentSimMode === mode) return;
    currentSimMode = mode;
    
    // Refresh card to trigger re-mount
    const card = document.querySelector('.sb-card.sb-card-wide');
    if (card) {
      card.click();
      setTimeout(() => {
        const newCard = document.querySelector(`.sb-card[data-code="${card.getAttribute('data-code')}"]`);
        if (newCard) newCard.click();
      }, 150);
    }
  }
})();
