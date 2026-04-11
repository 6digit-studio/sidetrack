/**
 * DOM event capture - clicks, navigation, visibility, focus (browser only)
 */

import type { Transport, CaptureModule } from '../types';
import { detectRuntime } from '../runtime';

/**
 * Generate a CSS-like selector for an element
 */
function getSelector(el: Element): string {
  if (!el) return '';
  
  const parts: string[] = [];
  
  // Tag name
  parts.push(el.tagName.toLowerCase());
  
  // ID
  if (el.id) {
    parts.push(`#${el.id}`);
    return parts.join('');
  }
  
  // Classes (limit to 3)
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).slice(0, 3);
    if (classes.length > 0 && classes[0]) {
      parts.push('.' + classes.join('.'));
    }
  }
  
  // Data attributes that might be useful
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testId) {
    parts.push(`[data-testid="${testId}"]`);
  }
  
  // Text content (for buttons, links)
  if (['BUTTON', 'A'].includes(el.tagName)) {
    const text = el.textContent?.trim().slice(0, 30);
    if (text) {
      parts.push(` "${text}${text.length >= 30 ? '...' : ''}"`);
    }
  }
  
  return parts.join('');
}

export function captureDom(transport: Transport): CaptureModule {
  const runtime = detectRuntime();
  
  if (runtime !== 'browser') {
    return { destroy() {} };
  }
  
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { destroy() {} };
  }
  
  const cleanupFns: Array<() => void> = [];
  
  // Click capture
  const clickHandler = (event: MouseEvent) => {
    const target = event.target as Element;
    if (!target) return;
    
    transport.send({
      _type: 'dom.click',
      target: getSelector(target),
      x: event.clientX,
      y: event.clientY,
    });
  };
  document.addEventListener('click', clickHandler, true);
  cleanupFns.push(() => document.removeEventListener('click', clickHandler, true));
  
  // Form submit capture
  const submitHandler = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement;
    if (!form) return;
    
    transport.send({
      _type: 'dom.submit',
      target: getSelector(form),
      action: form.action,
      method: form.method?.toUpperCase(),
    });
  };
  document.addEventListener('submit', submitHandler, true);
  cleanupFns.push(() => document.removeEventListener('submit', submitHandler, true));
  
  // Navigation: popstate
  let currentUrl = window.location.href;
  const popstateHandler = () => {
    const newUrl = window.location.href;
    transport.send({
      _type: 'dom.navigate',
      from: currentUrl,
      to: newUrl,
      trigger: 'popstate',
    });
    currentUrl = newUrl;
  };
  window.addEventListener('popstate', popstateHandler);
  cleanupFns.push(() => window.removeEventListener('popstate', popstateHandler));
  
  // Navigation: hashchange
  const hashchangeHandler = () => {
    const newUrl = window.location.href;
    transport.send({
      _type: 'dom.navigate',
      from: currentUrl,
      to: newUrl,
      trigger: 'hashchange',
    });
    currentUrl = newUrl;
  };
  window.addEventListener('hashchange', hashchangeHandler);
  cleanupFns.push(() => window.removeEventListener('hashchange', hashchangeHandler));
  
  // Navigation: intercept pushState and replaceState
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    const result = originalPushState(...args);
    const newUrl = window.location.href;
    transport.send({
      _type: 'dom.navigate',
      from: currentUrl,
      to: newUrl,
      trigger: 'pushstate',
    });
    currentUrl = newUrl;
    return result;
  };
  
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    const result = originalReplaceState(...args);
    const newUrl = window.location.href;
    transport.send({
      _type: 'dom.navigate',
      from: currentUrl,
      to: newUrl,
      trigger: 'replacestate',
    });
    currentUrl = newUrl;
    return result;
  };
  
  cleanupFns.push(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  });
  
  // Visibility change
  const visibilityHandler = () => {
    transport.send({
      _type: 'dom.visibility',
      state: document.visibilityState as 'visible' | 'hidden',
    });
  };
  document.addEventListener('visibilitychange', visibilityHandler);
  cleanupFns.push(() => document.removeEventListener('visibilitychange', visibilityHandler));
  
  // Focus/blur on window
  const focusHandler = () => {
    transport.send({ _type: 'dom.focus' });
  };
  const blurHandler = () => {
    transport.send({ _type: 'dom.blur' });
  };
  window.addEventListener('focus', focusHandler);
  window.addEventListener('blur', blurHandler);
  cleanupFns.push(() => {
    window.removeEventListener('focus', focusHandler);
    window.removeEventListener('blur', blurHandler);
  });
  
  return {
    destroy() {
      for (const fn of cleanupFns) {
        fn();
      }
    },
  };
}
