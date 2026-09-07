import type { MigrationClient } from './migrate.js';

/** Split statements without treating semicolons in strings or comments as separators. */
export function splitSql(input:string):string[]{
  const statements:string[]=[];let text='',quote='',lineComment=false,blockComment=false;
  for(let i=0;i<input.length;i++){
    const char=input[i]!,next=input[i+1];
    if(lineComment){if(char==='\n'){lineComment=false;text+='\n';}continue;}
    if(blockComment){if(char==='*'&&next==='/'){blockComment=false;i++;text+=' ';}continue;}
    if(quote){text+=char;if(char==='\\'&&next){text+=next;i++;}else if(char===quote){if(next===quote){text+=next;i++;}else quote='';}continue;}
    if(char==='-'&&next==='-'){lineComment=true;i++;continue;}
    if(char==='/'&&next==='*'){blockComment=true;i++;continue;}
    if(['\'', '"','`'].includes(char)){quote=char;text+=char;continue;}
    if(char===';'){if(text.trim())statements.push(text.trim());text='';}else text+=char;
  }
  if(quote||blockComment)throw new Error('MIGRATION_SQL_UNTERMINATED');
  if(text.trim())statements.push(text.trim());return statements;
}
function closing(text:string,start:number):number{
  let depth=0,quote='';
  for(let i=start;i<text.length;i++){
    const char=text[i]!;
    if(quote){if(char==='\\')i++;else if(char===quote){if(text[i+1]===quote)i++;else quote='';}continue;}
    if(['\'', '"','`'].includes(char)){quote=char;continue;}
    if(char==='(')depth++;else if(char===')'&&--depth===0)return i;
  }
  throw new Error('MIGRATION_SQL_UNBALANCED');
}
function splitColumns(text:string):string[]{
  const result:string[]=[];let start=0;
  for(let i=0;i<text.length;i++){if(text[i]==='(')i=closing(text,i);else if(text[i]===','){result.push(text.slice(start,i).trim());start=i+1;}}
  result.push(text.slice(start).trim());return result;
}
const normalized=(value:string)=>value.replaceAll(/\s+/g,'').replaceAll('"','').replaceAll('`','');
// ClickHouse canonicalizes Boolean/Bool aliases in DESCRIBE; both use UInt8 storage.
const normalizedType=(value:string)=>normalized(value).replaceAll(/(^|[(,])(?:Boolean|Bool)(?=[),]|$)/g,'$1UInt8');
function columns(declaration:string):[string,string][]{
  if(/^(?:INDEX|CONSTRAINT|PRIMARY|PROJECTION)\b/i.test(declaration))return [];
  const match=/^["`]?([A-Za-z_][\w.]*)["`]?\s+([A-Za-z_][\w]*)\s*/.exec(declaration);
  if(!match)throw new Error('MIGRATION_COLUMN_DECLARATION_INVALID');
  const start=match[0].length;
  const type=match[2]!+(declaration[start]==='('?declaration.slice(start,closing(declaration,start)+1):'');
  if(match[2]==='Nested')return splitColumns(type.slice(type.indexOf('(')+1,-1)).flatMap(column=>columns(column).map(([name,value]):[string,string]=>[match[1]+'.'+name,`Array(${value})`]));
  return [[match[1]!,normalizedType(type)]];
}
const objectName='((?:["`]?[A-Za-z_][\\w]*["`]?\\.)["`]?[A-Za-z_][\\w]*["`]?)';
export function validateMigrationStatements(statements:readonly string[]):void {
  if(!statements.length)throw new Error('MIGRATION_STATEMENTS_REQUIRED');
  for(const sql of statements)if(![
    new RegExp('^CREATE TABLE IF NOT EXISTS '+objectName+'\\s*\\(','i'),
    new RegExp('^CREATE (?:OR REPLACE VIEW |VIEW IF NOT EXISTS )'+objectName+'\\s+AS\\s+','i'),
    new RegExp('^CREATE MATERIALIZED VIEW IF NOT EXISTS '+objectName+'\\s+TO\\s+'+objectName+'\\s+AS\\s+','i'),
    new RegExp('^ALTER TABLE '+objectName+'\\s+ADD COLUMN IF NOT EXISTS\\s+','i'),
    /^CREATE DATABASE IF NOT EXISTS\s+[A-Za-z_][\w]*$/i,
  ].some(pattern=>pattern.test(sql)))throw new Error('MIGRATION_RETRY_SAFE_DDL_REQUIRED');
}
const literal=(value:string)=>"'"+value.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";
async function describe(client:MigrationClient,expression:string):Promise<Map<string,string>>{
  const result:unknown=JSON.parse(await client.query(`DESCRIBE TABLE ${expression} FORMAT JSON`));
  if(!result||typeof result!=='object'||!('data'in result)||!Array.isArray(result.data))throw new Error('MIGRATION_SCHEMA_RESPONSE_INVALID');
  const output=new Map<string,string>();
  for(const value of result.data as unknown[]){
    if(!value||typeof value!=='object'||!('name'in value)||!('type'in value)||typeof value.name!=='string'||typeof value.type!=='string')throw new Error('MIGRATION_SCHEMA_RESPONSE_INVALID');
    output.set(value.name,normalizedType(value.type));
  }
  return output;
}
/** Verify columns/types and engines plus actual view output shapes/readability.
 * Additive later migrations may add columns; IF NOT EXISTS alone is never proof. */
export async function assertMigrationSchema(client:MigrationClient,statements:readonly string[]):Promise<void>{
  const tables=new Map<string,{columns:Map<string,string>;engine?:string}>(),views=new Map<string,string>();
  for(const sql of statements){
    const table=new RegExp('^CREATE TABLE (?:IF NOT EXISTS )?'+objectName+'\\s*\\(','i').exec(sql);
    const alter=new RegExp('^ALTER TABLE '+objectName+'\\s+ADD COLUMN IF NOT EXISTS\\s+([\\s\\S]+)$','i').exec(sql);
    const view=new RegExp('^CREATE (?:OR REPLACE )?VIEW (?:IF NOT EXISTS )?'+objectName+'\\s+AS\\s+([\\s\\S]+)$','i').exec(sql);
    const materialized=new RegExp('^CREATE MATERIALIZED VIEW IF NOT EXISTS '+objectName+'\\s+TO\\s+'+objectName+'\\s+AS\\s+([\\s\\S]+)$','i').exec(sql);
    if(table){
      const name=normalized(table[1]!),start=table[0].length-1,end=closing(sql,start),engine=/\bENGINE\s*=\s*([A-Za-z_][\w]*)/i.exec(sql.slice(end+1));
      tables.set(name,{columns:new Map(splitColumns(sql.slice(start+1,end)).flatMap(columns)),...(engine?{engine:engine[1]!}:{})});
    }else if(alter){
      const name=normalized(alter[1]!);let shape=tables.get(name);if(!shape){shape={columns:new Map()};tables.set(name,shape);}for(const [key,value]of columns(alter[2]!))shape.columns.set(key,value);
    }else if(view)views.set(normalized(view[1]!),view[2]!);
    else if(materialized)views.set(normalized(materialized[1]!),materialized[3]!);
    else if(/^CREATE DATABASE IF NOT EXISTS\s+[A-Za-z_][\w]*$/i.test(sql)){
      const database=sql.split(/\s+/).at(-1)!;if((await client.query(`EXISTS DATABASE ${database}`)).trim()!=='1')throw new Error(`MIGRATION_DATABASE_MISSING:${database}`);
    }else throw new Error('MIGRATION_SCHEMA_VERIFICATION_UNSUPPORTED_DDL');
  }
  for(const [table,expected]of tables){
    const actual=await describe(client,table);
    for(const [name,type]of expected.columns)if(actual.get(name)!==type)throw new Error(`MIGRATION_COLUMN_DRIFT:${table}:${name}`);
    if(expected.engine){const [database,name]=table.split('.');if((await client.query(`SELECT engine FROM system.tables WHERE database=${literal(database!)} AND name=${literal(name!)}`)).trim()!==expected.engine)throw new Error(`MIGRATION_ENGINE_DRIFT:${table}`);}
  }
  for(const [view,query]of views){
    const actual=await describe(client,view),expected=await describe(client,`(${query})`);
    for(const [name,type]of expected)if(actual.get(name)!==type)throw new Error(`MIGRATION_VIEW_DRIFT:${view}:${name}`);
    await client.query(`SELECT * FROM ${view} LIMIT 0`);
  }
}
