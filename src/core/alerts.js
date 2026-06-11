/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function create({ condition, price, message }) {
  const priceText = String(price);
  const opened = await evaluate(`
    (function() {
      try {
        var widget = window.TradingViewApi && window.TradingViewApi._alertsWidgetDialog;
        if (widget && typeof widget.show === 'function') {
          widget.show();
          return true;
        }
      } catch (e) {}
      var btn = document.querySelector('[aria-label="建立快訊"]')
        || document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await sleep(1000);

  let priceSet = false;
  for (let attempt = 0; attempt < 10 && !priceSet; attempt++) {
    const focused = await evaluate(`
      (function() {
        var input = document.querySelector('[data-qa-id="ui-lib-Input-input end-band-range-input"]');
        if (!input) {
          var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
          for (var i = 0; i < inputs.length; i++) {
            var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
            if (label && /value|price/i.test(label.textContent)) { input = inputs[i]; break; }
          }
        }
        if (!input) return false;
        input.focus();
        if (typeof input.select === 'function') input.select();
        return true;
      })()
    `);
    if (!focused) {
      await sleep(250);
      continue;
    }
    await evaluate(`
      (function() {
        var input = document.querySelector('[data-qa-id="ui-lib-Input-input end-band-range-input"]');
        if (!input) return false;
        input.focus();
        if (typeof input.select === 'function') input.select();
        return document.execCommand('insertText', false, ${JSON.stringify(priceText)});
      })()
    `);
    await sleep(250);
    priceSet = await evaluate(`
      (function() {
        var input = document.querySelector('[data-qa-id="ui-lib-Input-input end-band-range-input"]');
        return !!input && input.value === ${JSON.stringify(priceText)};
      })()
    `);
    if (!priceSet) await sleep(250);
  }

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('textarea.message-input')
          || document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]')
          || document.querySelector('textarea[placeholder*="說的嗎"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
  }

  await sleep(500);
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/^(建立|Create)$/i.test(text)) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  await sleep(1000);

  return {
    success: !!created,
    price,
    condition,
    message: message || '(none)',
    price_set: !!priceSet,
    source: 'dom_fallback',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
