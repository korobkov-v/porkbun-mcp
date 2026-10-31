import test from 'node:test';
import assert from 'node:assert/strict';
import { cardPurchase, CardPaymentError } from '../dist/card-payment.js';
import { errorResult } from '../dist/result.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPorkbunServer } from '../dist/server.js';
const args={domain:'example.com',cost:798,idempotencyKey:'saved-request-key-001'};
const challenge={status:'PAYMENT_REQUIRED',method:'card',payUrl:'https://porkbun.com/pay/card/id',cardPaymentId:'card-id',expiresAt:'2030-01-01T00:00:00Z'};
async function mock(run, implementation) {
 const original=globalThis.fetch; const requests=[];
 globalThis.fetch=async(url,options)=>{requests.push({url,...options});return implementation(url,options);};
 try {await run(requests);} finally {globalThis.fetch=original;}
}
const purchase=(overrides={})=>cardPurchase('https://fixture.invalid','fixture-api-key','fixture-secret-key',{...args,...overrides});
const response=(status,body)=>new Response(JSON.stringify(body),{status});

test('card challenge and replay preserve caller key and numeric quote',async()=>{
 await mock(async requests=>{
  const result=await purchase(); await purchase();
  assert.equal(result.status,'PAYMENT_REQUIRED');assert.equal(result.charged,false);
  assert.equal(requests.length,2);assert.equal(requests[0].body,requests[1].body);
  assert.equal(requests[0].headers['Idempotency-Key'],args.idempotencyKey);
  assert.equal(requests[0].redirect,'error');
  assert.equal(JSON.parse(requests[0].body).cost,798);
  assert.equal(JSON.parse(requests[0].body).payWith,'card');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
 },()=>response(402,{...challenge,message:'SECRET instructions',apikey:'SECRET',nested:{secret:'SECRET'}}));
});
test('completion preserves payment id and filters successful payload',async()=>{
 await mock(async requests=>{
  const result=await purchase({cardPaymentId:'card-id',idempotencyKey:'completion-key-002'});
  assert.equal(result.registered,true);assert.equal(JSON.parse(requests[0].body).cardPaymentId,'card-id');
  assert.deepEqual(result.payment,{charged:true,paidWith:'card'});
  assert.ok(!JSON.stringify(result).includes('SECRET'));
 },()=>response(200,{status:'SUCCESS',secret:'SECRET',payment:{charged:true,paidWith:'card',paymentIntent:'SECRET'}}));
});
for(const code of ['PAYMENT_MISMATCH','PAYMENT_NOT_FOUND','PAYMENT_ALREADY_USED','PAYMENT_EXPIRED','PAYMENT_IN_PROGRESS','IDEMPOTENCY_KEY_MISMATCH','RATE_LIMITED']) {
 test('preserve safe error state '+code,async()=>{
  await mock(async requests=>{
   await assert.rejects(purchase({cardPaymentId:'card-id'}),error=>{
    assert.ok(error instanceof CardPaymentError);assert.equal(error.details.status,code);
    assert.deepEqual(error.details.payment,{charged:false,holdReleased:true});
    const text=errorResult(error).content[0].text;
    assert.ok(!text.includes('SECRET'));assert.ok(text.includes(args.idempotencyKey));return true;
   });assert.equal(requests.length,1);
  },()=>response(code==='RATE_LIMITED'?429:409,{status:'ERROR',code,message:'SECRET',secretapikey:'SECRET',payment:{charged:false,holdReleased:true,secret:'SECRET'}}));
 });
}
for(const [name,implementation] of [
 ['timeout',()=>{throw new DOMException('SECRET','TimeoutError');}],
 ['network',()=>{throw new Error('SECRET');}],
 ['bad JSON',()=>new Response('SECRET',{status:502})],
 ['oversized',()=>new Response('x'.repeat(65537))],
 ['array',()=>response(200,[])],
 ['server failure',()=>response(503,{message:'SECRET'})],
 ...['https://evil.test/pay/id','https://porkbun.com.evil.test/pay/id','http://porkbun.com/pay/id','https://user:password@porkbun.com/pay/id','https://porkbun.com/pay/id#SECRET','https://porkbun.com/account/credit'].map(url=>[url,()=>response(402,{...challenge,payUrl:url})])
]) {
 test('uncertain or unsafe response: '+name,async()=>{
  await mock(async requests=>{
   await assert.rejects(purchase(),error=>{
    assert.equal(error.details.outcome,'unknown');assert.equal(error.details.charged,undefined);
    assert.ok(!JSON.stringify(error.details).includes('SECRET'));return true;
   });assert.equal(requests.length,1);
  },implementation);
 });
}
test('MCP validation, dry run, card gates and serialized response',async()=>{
 await mock(async requests=>{
  for(const gates of [{getMuddy:true,enableDomainCreate:true},{getMuddy:false,enableDomainCreate:true},{getMuddy:true,enableDomainCreate:false}]) {
   const server=createPorkbunServer({apiKey:'fixture-api',secretKey:'fixture-secret',baseUrl:'https://fixture.invalid',...gates});
   const client=new Client({name:'card-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
   try {
    await server.connect(a);await client.connect(b);
    const input={domain:'example.com',cost:798,pay_with:'card',agree_to_terms:true,confirm_apply:true,dry_run:false,idempotency_key:args.idempotencyKey};
    const call=overrides=>client.callTool({name:'domains_create',arguments:{...input,...overrides}});
    const before=requests.length;
    if(!gates.getMuddy||!gates.enableDomainCreate) assert.equal((await call({})).isError,true);
    else {
     for(const overrides of [{idempotency_key:undefined},{idempotency_key:'bad\r\nheader'},{pay_with:undefined,card_payment_id:'id'},{confirm_apply:false},{agree_to_terms:false},{pay_with:'usdc'}]) assert.equal((await call(overrides)).isError,true);
     assert.equal((await call({dry_run:true,idempotency_key:undefined})).isError,undefined);
    }
    assert.equal(requests.length,before);
    if(gates.getMuddy&&gates.enableDomainCreate) {
     const result=await call({});assert.equal(JSON.parse(result.content[0].text).status,'PAYMENT_REQUIRED');
    }
   } finally {await client.close();await server.close();}
  }
 },()=>response(402,challenge));
});

for(const [name,body] of [
 ['expired',{...challenge,expiresAt:'2020-01-01T00:00:00Z'}],
 ['wrong method',{...challenge,method:'usdc'}],
 ['invalid expiry',{...challenge,expiresAt:'invalid'}],
 ['missing id',{...challenge,cardPaymentId:undefined}],
 ['query',{...challenge,payUrl:'https://porkbun.com/pay/id?secret=value'}],
 ['reflection',{...challenge,payUrl:'https://porkbun.com/pay/fixture-secret-key'}],
]) test('reject challenge '+name,async()=>{
 await mock(async()=>{
  await assert.rejects(purchase(),e=>{
   assert.ok(e instanceof CardPaymentError);
   assert.ok(!JSON.stringify(e.details).includes('fixture-secret-key'));return true;
  });
 },()=>response(402,body));
});
test('missing payment state does not invent a released hold',async()=>{
 await mock(async()=>{
  await assert.rejects(purchase(),e=>{assert.deepEqual(e.details.payment,{});return true;});
 },()=>response(429,{status:'ERROR',code:'RATE_LIMITED'}));
});
