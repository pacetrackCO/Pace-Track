'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app.cjs');

test('clean page routes redirect to their canonical directories so relative assets still load', async () => {
    const app = createApp({
        sessionSecret: 'isolated-public-route-test-secret-only',
        repository: {}
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const base = 'http://127.0.0.1:' + server.address().port;
        for (const [alias, canonical] of [
            ['/timer', '/timer/timer.html'],
            ['/timer-loop', '/timer_loop/timer_loop.html'],
            ['/timer-sector', '/timer_sector/timer_sector.html'],
            ['/eventos', '/events/events.html'],
            ['/construccion', '/Construccion/construccion.html']
        ]) {
            const response = await fetch(base + alias + '?example=1', { redirect: 'manual' });
            assert.equal(response.status, 302);
            assert.equal(response.headers.get('location'), canonical + '?example=1');
            const page = await fetch(base + canonical);
            assert.equal(page.status, 200);
            assert.match(page.headers.get('content-type'), /text\/html/);
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});