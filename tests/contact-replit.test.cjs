const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
const contactSection = script.slice(
    script.indexOf('// NOTIFICACIONES'),
    script.indexOf('// SCROLL TO TOP')
);
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function makeHarness(fetchImpl = async () => ({ ok: true })) {
    const notification = { textContent: '', classList: { add() {}, remove() {} } };
    const button = { disabled: false };
    const form = {
        values: { nombre: 'Ada Lovelace', email: 'ada@example.com', mensaje: 'Hola PaceTrack', 'bot-field': '' },
        listeners: {},
        resetCalls: 0,
        addEventListener(type, callback) { this.listeners[type] = callback; },
        querySelector() { return button; },
        reset() {
            this.resetCalls += 1;
            this.values = { nombre: '', email: '', mensaje: '', 'bot-field': '' };
        }
    };
    class FormDataMock {
        constructor(target) { this.values = target.values; }
        get(name) { return this.values[name] ?? null; }
    }
    const document = {
        getElementById(id) {
            return id === 'contactForm' ? form : id === 'notification' ? notification : null;
        }
    };
    const context = {
        document,
        FormData: FormDataMock,
        fetch: fetchImpl,
        JSON,
        setTimeout() {}
    };
    vm.runInNewContext(contactSection, context, { filename: 'script.js contact form' });
    return {
        form,
        button,
        notification,
        submit() {
            return form.listeners.submit({
                preventDefault() {},
                currentTarget: form,
                target: form
            });
        }
    };
}

test('contact form posts the Replit JSON contract and resets only after success', async () => {
    let resolveFetch;
    const requests = [];
    const harness = makeHarness((url, options) => {
        requests.push({ url, options });
        return new Promise(resolve => { resolveFetch = resolve; });
    });

    const submission = harness.submit();
    assert.equal(harness.notification.textContent, 'Enviando mensaje…');
    assert.equal(harness.button.disabled, true);
    assert.equal(harness.form.resetCalls, 0);
    resolveFetch({ ok: true });
    await submission;

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/contact');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        nombre: 'Ada Lovelace',
        email: 'ada@example.com',
        mensaje: 'Hola PaceTrack'
    });
    assert.equal(harness.form.resetCalls, 1);
    assert.match(harness.notification.textContent, /Mensaje recibido/);
    assert.doesNotMatch(harness.notification.textContent, /enviado|responderemos/i);
    assert.equal(harness.button.disabled, false);
});

test('invalid fields and a filled honeypot are rejected without contacting the server', async () => {
    const requests = [];
    const harness = makeHarness(async (...args) => {
        requests.push(args);
        return { ok: true };
    });

    harness.form.values.nombre = 'n'.repeat(101);
    await harness.submit();
    assert.equal(requests.length, 0);
    assert.equal(harness.form.resetCalls, 0);
    assert.match(harness.notification.textContent, /Revisa los campos/);

    harness.form.values.nombre = 'Ada Lovelace';
    harness.form.values['bot-field'] = 'filled by bot';
    await harness.submit();
    assert.equal(requests.length, 0);
    assert.equal(harness.form.resetCalls, 0);
    assert.match(harness.notification.textContent, /validar el formulario/);
});

test('server failures and network errors preserve values and allow retry', async () => {
    let calls = 0;
    const harness = makeHarness(async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 500 };
        if (calls === 2) throw new Error('offline');
        return { ok: true };
    });

    await harness.submit();
    assert.match(harness.notification.textContent, /No se pudo guardar/);
    assert.equal(harness.form.resetCalls, 0);
    assert.equal(harness.form.values.mensaje, 'Hola PaceTrack');
    assert.equal(harness.button.disabled, false);

    await harness.submit();
    assert.match(harness.notification.textContent, /No se pudo guardar/);
    assert.equal(harness.form.resetCalls, 0);
    assert.equal(harness.form.values.email, 'ada@example.com');

    await harness.submit();
    assert.equal(calls, 3);
    assert.equal(harness.form.resetCalls, 1);
    assert.match(harness.notification.textContent, /Mensaje recibido/);
});

test('contact markup uses same-origin API fields and drops Netlify form metadata', () => {
    const form = html.match(/<form\b[^>]*id=["']contactForm["'][^>]*>([\s\S]*?)<\/form>/i);
    assert.ok(form);
    assert.match(form[0], /\baction=["']\/api\/contact["']/i);
    assert.doesNotMatch(form[0], /data-netlify|form-name/i);
    assert.match(form[1], /name=["']bot-field["']/i);
    assert.match(form[1], /name=["']nombre["'][^>]*maxlength=["']100["']/i);
    assert.match(form[1], /name=["']email["'][^>]*maxlength=["']254["']/i);
    assert.match(form[1], /name=["']mensaje["'][^>]*maxlength=["']5000["']/i);
});