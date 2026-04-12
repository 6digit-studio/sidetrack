/**
 * Feedback widget - floating UI for capturing user feedback with context
 * Browser only.
 */

import type { CaptureModule, Config } from '../types';
import { detectRuntime } from '../runtime';

export interface FeedbackConfig {
  enabled: boolean;
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  hotkey: string;  // e.g., 'ctrl+shift+f'
  captureDOM: boolean;
  captureRecentEvents: number;  // How many recent events to include
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  enabled: true,
  position: 'bottom-right',
  hotkey: 'ctrl+shift+f',
  captureDOM: true,
  captureRecentEvents: 10,
};

const STORAGE_KEY = 'sidetrack-feedback-position';
const DRAFT_STORAGE_KEY = 'sidetrack-feedback-draft';

// Store recent events for context
let recentEvents: unknown[] = [];
const MAX_RECENT_EVENTS = 50;

export function addRecentEvent(event: unknown) {
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents = recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

export function getRecentEvents(count: number): unknown[] {
  return recentEvents.slice(-count);
}

/**
 * Load saved position from localStorage
 */
function loadPosition(): { x: number; y: number } | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const pos = JSON.parse(stored);
      if (typeof pos.x === 'number' && typeof pos.y === 'number') {
        return pos;
      }
    }
  } catch {
    // Ignore localStorage errors
  }
  return null;
}

/**
 * Save position to localStorage
 */
function savePosition(x: number, y: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Load draft feedback text from localStorage
 */
function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Save draft feedback text to localStorage
 */
function saveDraft(text: string) {
  try {
    if (text) {
      localStorage.setItem(DRAFT_STORAGE_KEY, text);
    } else {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Clear draft from localStorage
 */
function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Capture a simplified DOM snapshot
 */
function captureDOMSnapshot(): string {
  if (typeof document === 'undefined') return '';
  
  // Get the visible viewport area
  const viewportHTML = document.documentElement.outerHTML;
  
  // Truncate if too large (keep it reasonable)
  const maxSize = 50000;  // 50KB
  if (viewportHTML.length > maxSize) {
    return viewportHTML.slice(0, maxSize) + '\n<!-- truncated -->';
  }
  
  return viewportHTML;
}

/**
 * Get CSS selector path to focused element
 */
function getFocusedElementPath(): string | null {
  if (typeof document === 'undefined') return null;
  
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  
  const parts: string[] = [];
  let current: Element | null = el;
  
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
    } else if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).slice(0, 2);
      if (classes.length && classes[0]) {
        selector += '.' + classes.join('.');
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }
  
  return parts.join(' > ');
}

/**
 * Create and inject the widget styles
 */
function injectStyles() {
  if (document.getElementById('sidetrack-feedback-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'sidetrack-feedback-styles';
  style.textContent = `
    #sidetrack-feedback-btn {
      position: fixed;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #2563eb;
      color: white;
      border: none;
      cursor: grab;
      font-size: 18px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      z-index: 999998;
      transition: transform 0.15s, background 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      touch-action: none;
    }
    #sidetrack-feedback-btn:hover {
      transform: scale(1.1);
      background: #1d4ed8;
    }
    #sidetrack-feedback-btn.dragging {
      cursor: grabbing;
      transform: scale(1.15);
      transition: none;
    }
    
    #sidetrack-feedback-modal {
      position: fixed;
      z-index: 999999;
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
      width: 320px;
      max-width: calc(100vw - 40px);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: none;
    }
    #sidetrack-feedback-modal.visible { display: block; }
    
    #sidetrack-feedback-modal header {
      padding: 12px 16px;
      border-bottom: 1px solid #e5e7eb;
      font-weight: 600;
      font-size: 14px;
      color: #111827;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #sidetrack-feedback-modal header button {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 18px;
      color: #6b7280;
      padding: 0;
      line-height: 1;
    }
    #sidetrack-feedback-modal header button:hover { color: #111827; }
    
    #sidetrack-feedback-modal .body {
      padding: 16px;
    }
    #sidetrack-feedback-modal textarea {
      width: 100%;
      min-height: 80px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 10px;
      font-size: 14px;
      resize: vertical;
      font-family: inherit;
      box-sizing: border-box;
    }
    #sidetrack-feedback-modal textarea:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
    }
    #sidetrack-feedback-modal .hint {
      font-size: 11px;
      color: #6b7280;
      margin-top: 8px;
    }
    #sidetrack-feedback-modal footer {
      padding: 12px 16px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    #sidetrack-feedback-modal footer button {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: none;
    }
    #sidetrack-feedback-modal footer .cancel {
      background: #f3f4f6;
      color: #374151;
    }
    #sidetrack-feedback-modal footer .cancel:hover { background: #e5e7eb; }
    #sidetrack-feedback-modal footer .submit {
      background: #2563eb;
      color: white;
    }
    #sidetrack-feedback-modal footer .submit:hover { background: #1d4ed8; }
    #sidetrack-feedback-modal footer .submit:disabled {
      background: #93c5fd;
      cursor: not-allowed;
    }
    
    #sidetrack-feedback-toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #065f46;
      color: white;
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      z-index: 1000000;
      opacity: 0;
      transition: opacity 0.2s;
    }
    #sidetrack-feedback-toast.visible { opacity: 1; }
  `;
  document.head.appendChild(style);
}

/**
 * Create the widget DOM elements
 */
function createWidget(config: FeedbackConfig, endpoint: string) {
  // Button
  const btn = document.createElement('button');
  btn.id = 'sidetrack-feedback-btn';
  btn.innerHTML = '?';
  btn.title = `Send feedback (${config.hotkey}) - drag to reposition`;
  
  // Modal
  const modal = document.createElement('div');
  modal.id = 'sidetrack-feedback-modal';
  modal.innerHTML = `
    <header>
      <span>Quick Feedback</span>
      <button type="button" aria-label="Close">&times;</button>
    </header>
    <div class="body">
      <textarea placeholder="What did you notice? What's not working?"></textarea>
      <div class="hint">Context (URL, DOM, recent events) captured automatically</div>
    </div>
    <footer>
      <button type="button" class="cancel">Cancel</button>
      <button type="button" class="submit">Send</button>
    </footer>
  `;
  
  // Toast
  const toast = document.createElement('div');
  toast.id = 'sidetrack-feedback-toast';
  toast.textContent = 'Feedback sent!';
  
  document.body.appendChild(btn);
  document.body.appendChild(modal);
  document.body.appendChild(toast);
  
  // Position the button
  const savedPos = loadPosition();
  if (savedPos) {
    // Use saved position
    btn.style.left = `${savedPos.x}px`;
    btn.style.top = `${savedPos.y}px`;
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  } else {
    // Use default position from config
    switch (config.position) {
      case 'bottom-right':
        btn.style.bottom = '20px';
        btn.style.right = '20px';
        break;
      case 'bottom-left':
        btn.style.bottom = '20px';
        btn.style.left = '20px';
        break;
      case 'top-right':
        btn.style.top = '20px';
        btn.style.right = '20px';
        break;
      case 'top-left':
        btn.style.top = '20px';
        btn.style.left = '20px';
        break;
    }
  }
  
  // Elements
  const closeBtn = modal.querySelector('header button') as HTMLButtonElement;
  const textarea = modal.querySelector('textarea') as HTMLTextAreaElement;
  const cancelBtn = modal.querySelector('.cancel') as HTMLButtonElement;
  const submitBtn = modal.querySelector('.submit') as HTMLButtonElement;
  
  // State
  let isOpen = false;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let btnStartX = 0;
  let btnStartY = 0;
  let hasDragged = false;
  
  function updateModalPosition() {
    const btnRect = btn.getBoundingClientRect();
    const modalWidth = 320;
    const modalHeight = 250; // approximate
    const padding = 10;
    
    // Determine best position for modal relative to button
    let left = btnRect.left;
    let top = btnRect.bottom + padding;
    
    // If modal would go off right edge, align to right of button
    if (left + modalWidth > window.innerWidth - padding) {
      left = btnRect.right - modalWidth;
    }
    
    // If modal would go off bottom, show above button
    if (top + modalHeight > window.innerHeight - padding) {
      top = btnRect.top - modalHeight - padding;
    }
    
    // Clamp to viewport
    left = Math.max(padding, Math.min(left, window.innerWidth - modalWidth - padding));
    top = Math.max(padding, Math.min(top, window.innerHeight - modalHeight - padding));
    
    modal.style.left = `${left}px`;
    modal.style.top = `${top}px`;
    modal.style.right = 'auto';
    modal.style.bottom = 'auto';
  }
  
  function open() {
    isOpen = true;
    updateModalPosition();
    modal.classList.add('visible');
    textarea.value = loadDraft();
    textarea.focus();
  }
  
  function close() {
    isOpen = false;
    modal.classList.remove('visible');
  }
  
  function showToast() {
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
  }
  
  async function submit() {
    const message = textarea.value.trim();
    if (!message) return;
    
    submitBtn.disabled = true;
    
    // Build context
    const context: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      focusedElement: getFocusedElementPath(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      recentEvents: config.captureRecentEvents > 0 
        ? getRecentEvents(config.captureRecentEvents) 
        : [],
    };
    
    if (config.captureDOM) {
      context.domSnapshot = captureDOMSnapshot();
    }
    
    try {
      const feedbackEndpoint = endpoint.replace('/events', '/feedback');
      await fetch(feedbackEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          url: window.location.href,
          context,
        }),
      });
      
      clearDraft();
      close();
      showToast();
    } catch (e) {
      console.error('[sidetrack] Failed to send feedback:', e);
    } finally {
      submitBtn.disabled = false;
    }
  }
  
  // Drag handling
  function onDragStart(e: MouseEvent | TouchEvent) {
    isDragging = true;
    hasDragged = false;
    btn.classList.add('dragging');
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    dragStartX = clientX;
    dragStartY = clientY;
    
    const rect = btn.getBoundingClientRect();
    btnStartX = rect.left;
    btnStartY = rect.top;
    
    e.preventDefault();
  }
  
  function onDragMove(e: MouseEvent | TouchEvent) {
    if (!isDragging) return;
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    const deltaX = clientX - dragStartX;
    const deltaY = clientY - dragStartY;
    
    // Consider it a drag if moved more than 5px
    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
      hasDragged = true;
    }
    
    let newX = btnStartX + deltaX;
    let newY = btnStartY + deltaY;
    
    // Clamp to viewport
    const btnSize = 40;
    newX = Math.max(0, Math.min(newX, window.innerWidth - btnSize));
    newY = Math.max(0, Math.min(newY, window.innerHeight - btnSize));
    
    btn.style.left = `${newX}px`;
    btn.style.top = `${newY}px`;
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    
    // Update modal position if open
    if (isOpen) {
      updateModalPosition();
    }
  }
  
  function onDragEnd() {
    if (!isDragging) return;
    
    isDragging = false;
    btn.classList.remove('dragging');
    
    // Save position
    const rect = btn.getBoundingClientRect();
    savePosition(rect.left, rect.top);
  }
  
  // Mouse drag events
  btn.addEventListener('mousedown', onDragStart);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  
  // Touch drag events
  btn.addEventListener('touchstart', onDragStart, { passive: false });
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('touchend', onDragEnd);
  
  // Click to open (only if not dragged)
  btn.addEventListener('click', (e) => {
    if (hasDragged) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    isOpen ? close() : open();
  });
  
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  submitBtn.addEventListener('click', submit);
  
  // Save draft as user types
  textarea.addEventListener('input', () => {
    saveDraft(textarea.value);
  });
  
  // Submit on Ctrl+Enter
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      close();
    }
  });
  
  // Global hotkey
  document.addEventListener('keydown', (e) => {
    const hotkey = config.hotkey.toLowerCase();
    const ctrl = hotkey.includes('ctrl') ? e.ctrlKey : true;
    const shift = hotkey.includes('shift') ? e.shiftKey : true;
    const alt = hotkey.includes('alt') ? e.altKey : true;
    const meta = hotkey.includes('meta') || hotkey.includes('cmd') ? e.metaKey : true;
    
    // Extract the key (last part after all modifiers)
    const keyPart = hotkey.split('+').pop() || '';
    
    if (ctrl && shift && alt && meta && e.key.toLowerCase() === keyPart) {
      e.preventDefault();
      isOpen ? close() : open();
    }
  });
  
  // Click outside to close
  document.addEventListener('click', (e) => {
    if (isOpen && !modal.contains(e.target as Node) && e.target !== btn) {
      close();
    }
  });
  
  return { open, close };
}

export function captureFeedback(config: Config, feedbackConfig: FeedbackConfig): CaptureModule {
  const runtime = detectRuntime();
  
  if (runtime !== 'browser' || !feedbackConfig.enabled) {
    return { destroy() {} };
  }
  
  if (typeof document === 'undefined') {
    return { destroy() {} };
  }
  
  injectStyles();
  const widget = createWidget(feedbackConfig, config.endpoint);
  
  return {
    destroy() {
      const btn = document.getElementById('sidetrack-feedback-btn');
      const modal = document.getElementById('sidetrack-feedback-modal');
      const toast = document.getElementById('sidetrack-feedback-toast');
      const styles = document.getElementById('sidetrack-feedback-styles');
      
      btn?.remove();
      modal?.remove();
      toast?.remove();
      styles?.remove();
    },
  };
}
