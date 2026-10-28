import test from'node:test';import assert from'node:assert/strict';
import{withSec029Scope}from'../lib/avsec/reports/sec029-scope.ts';
test('SEC029 preserves canonical KUL entity station and active team over a stale airport-only draft',()=>{const result=withSec029Scope({station:'KUL',team:'BRAVO',flight_no:'AK9083'},{station:'KUL - MAA',team:'ALPHA'});assert.equal(result.station,'KUL - MAA');assert.equal(result.team,'ALPHA');assert.equal(result.flight_no,'AK9083');});
test('SEC029 cannot use a client-selected station to change the submitter scope',()=>{assert.deepEqual(withSec029Scope({station:'PEN',team:'OTHER'},{station:'KUL - AAX',team:'ALPHA'}),{station:'KUL - AAX',team:'ALPHA'});});
