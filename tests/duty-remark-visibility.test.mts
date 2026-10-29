import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
mock.module('next/dynamic',{defaultExport:()=>()=>null});
mock.module('next/navigation',{namedExports:{useRouter:()=>({refresh(){}})}});
mock.module('@/lib/avsec/duty/checkin-actions',{namedExports:{submitDutyCheckIn:async()=>({ok:true}),submitDutyCheckOut:async()=>({ok:true})}});
mock.module('@/lib/avsec/duty/absence-actions',{namedExports:{submitLeaveApplication:async()=>({ok:true})}});
mock.module('@/lib/avsec/offline/useOfflineSubmit',{namedExports:{useOfflineSubmit:()=>({submit:async()=>({kind:'success'}),pending:false})}});
const {CheckInScreen}=await import('../components/avsec/duty/CheckInScreen.tsx');
const noonMY=new Date('2026-10-29T12:00:00+08:00').getTime();
function screen(start:string,end:string,checkedIn=false){return renderToStaticMarkup(React.createElement(CheckInScreen,{profileId:'no-real-user',roster:{shift_code:'DAY',start_time:start,end_time:end,zone_id:null,notes:null},zones:[],record:checkedIn?{id:'no-real-duty',shift_code:'DAY',check_in_at:'2026-10-29T03:00:00Z',check_out_at:null,status:'present',late_minutes:0,late_remark:null,early_out_minutes:0,early_out_remark:null,check_in_inside_fence:true,check_in_accuracy_m:5}:null}));}
for(const [name,start,end,out,label]of [
 ['early check-in','13:00','21:00',false,'Checking in early'],
 ['late check-in','11:00','19:00',false,'Checking in late'],
 ['early check-out','05:00','13:00',true,'Checking out early'],
 ['late check-out','03:00','11:00',true,'Checking out late'],
] as const)test(name+' exposes an accessible remark input',t=>{
 t.mock.timers.enable({apis:['Date'],now:noonMY});const html=screen(start,end,out);
 assert.match(html,new RegExp(label));assert.match(html,/<textarea[^>]*id="duty-remark"/);assert.match(html,/for="duty-remark"/);
});
test('on-time check-in still offers an optional remark for device/server clock differences',t=>{
 t.mock.timers.enable({apis:['Date'],now:noonMY});const html=screen('12:00','20:00');assert.match(html,/<textarea[^>]*id="duty-remark"/);assert.match(html,/Remark \(optional\)/);
});
