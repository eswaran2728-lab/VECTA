import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {installJsdom} from './mocks/dom-setup.mts';
installJsdom();
const React=(await import('react')).default;
const {render,screen,fireEvent,cleanup,waitFor}=await import('@testing-library/react');
const calls:Record<string,unknown>[]=[];
let response={kind:'error',message:'Test boundary — no real duty submission'};
mock.module('next/dynamic',{defaultExport:()=>()=>null});
mock.module('next/navigation',{namedExports:{useRouter:()=>({refresh(){}})}});
mock.module('@/lib/avsec/duty/checkin-actions',{namedExports:{submitDutyCheckIn:async()=>({ok:true}),submitDutyCheckOut:async()=>({ok:true})}});
mock.module('@/lib/avsec/duty/absence-actions',{namedExports:{submitLeaveApplication:async()=>({ok:true})}});
mock.module('@/lib/avsec/offline/useOfflineSubmit',{namedExports:{useOfflineSubmit:()=>({submit:async(payload:Record<string,unknown>)=>{calls.push(payload);return response;},pending:false})}});
const {CheckInScreen}=await import('../components/avsec/duty/CheckInScreen.tsx');
const position={coords:{latitude:0,longitude:0,accuracy:5},timestamp:Date.now()} as GeolocationPosition;
Object.defineProperty(navigator,'geolocation',{configurable:true,value:{watchPosition(success:PositionCallback){success(position);return 1;},clearWatch(){},getCurrentPosition(success:PositionCallback){success(position);}}});
function mount(start:string){render(React.createElement(CheckInScreen,{profileId:'isolated-component-test',roster:{shift_code:'DAY',start_time:start,end_time:'20:00',zone_id:null,notes:null},zones:[],record:null}));}
test.afterEach(()=>{cleanup();calls.length=0;});
test('early arrival remark can be typed and is sent without relying on device classification',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-29T12:00:00+08:00').getTime()});
 response={kind:'error',message:'Test boundary — no real duty submission'};mount('13:00');
 const input=screen.getByRole('textbox',{name:/Checking in early/});fireEvent.change(input,{target:{value:'Requested to arrive early for shift handover'}});
 fireEvent.click(screen.getByRole('button',{name:'Check in',exact:true}));
 await waitFor(()=>assert.equal(calls.length,1));
 assert.equal(calls[0].early_in_remark,'Requested to arrive early for shift handover');
 assert.equal(calls[0].late_remark,calls[0].early_in_remark);
});
test('server timing disagreement upgrades the visible remark field to required and permits retry',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-29T12:00:00+08:00').getTime()});
 response={kind:'error',message:"A remark is required — you're checking in early."};mount('12:00');
 fireEvent.click(screen.getByRole('button',{name:'Check in',exact:true}));
 const input=await screen.findByRole('textbox',{name:/Remark required/});assert.equal(input.getAttribute('aria-required'),'true');
 fireEvent.change(input,{target:{value:'Early handover requested by supervisor'}});
 fireEvent.click(screen.getByRole('button',{name:'Check in',exact:true}));
 await waitFor(()=>assert.equal(calls.length,2));assert.equal(calls[1].early_in_remark,'Early handover requested by supervisor');
});
