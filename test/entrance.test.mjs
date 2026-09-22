import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cli=fileURLToPath(new URL('../bin/eggox.mjs',import.meta.url))
function run(args, env, stdin='') {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...args],{env,stdio:['pipe','pipe','pipe']})
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d)
  child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));child.stdin.end(stdin)
 })
}
test('entrance CLI and MCP use existing stock, restore the star and report failures',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eggox-entrance-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 fs.writeFileSync(path.join(dir,'eggox.json'),JSON.stringify({id:'room:tpi_cats',name:'Cats'}))
 const changes=[];let appearance=null,refuse=false
 const items=[{id:'mint_cat',name:'Cat Door',thing:'Cat Door'},{id:'mint_ambiguous1',name:'Duplicate'},{id:'mint_ambiguous2',name:'Duplicate'}]
 const server=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer fixture-token')
  assert.equal(req.url,'/api/dev/games/tpi_cats/entrance')
  res.setHeader('content-type','application/json')
  if(req.method==='PUT') {
   let body='';for await(const part of req)body+=part
   const {item}=JSON.parse(body);changes.push(item)
   if(refuse){res.statusCode=422;res.end(JSON.stringify({error:'no_claim_here'}));return}
   appearance=item?{item_id:item,name:'Cat Door'}:null
  }
  res.end(JSON.stringify({room:{id:'room:tpi_cats',entrance:appearance},items}))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const env={...process.env,EGGOX_TOKEN:'fixture-token',EGGOX_SERVER:`http://127.0.0.1:${server.address().port}`,EGGOX_HOME:dir}
 let result=await run(['entrance',dir,'--json'],env);assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).room.entrance,null)
 result=await run(['entrance','set','Cat Door',dir,'--json'],env);assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).room.entrance.item_id,'mint_cat')
 result=await run(['entrance','set','Duplicate',dir],env);assert.equal(result.code,1);assert.match(result.stderr,/several stock mints/)
 result=await run(['entrance','set','Not in stock',dir],env);assert.equal(result.code,1)
 result=await run(['entrance','reset',dir,'--json'],env);assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout).room.entrance,null)
 assert.deepEqual(changes,['mint_cat',null])
 refuse=true;result=await run(['entrance','set','mint_cat',dir,'--json'],env);assert.equal(result.code,1);assert.match(result.stderr,/no_claim_here/);refuse=false
 const calls=[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'eggox_entrance',arguments:{action:'set',item:'mint_cat',dir}}}]
 result=await run(['mcp'],env,calls.map(x=>JSON.stringify(x)).join('\n')+'\n')
 assert.equal(result.code,0);const replies=result.stdout.trim().split('\n').map(x=>JSON.parse(x))
 assert(replies[0].result.tools.some(x=>x.name==='eggox_entrance'))
 assert.equal(replies[1].result.isError,undefined)
 assert.equal(JSON.parse(replies[1].result.content[0].text).room.entrance.item_id,'mint_cat')
})
