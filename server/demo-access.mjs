import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { AppError } from './store.mjs';

// The trusted gateway supplies an anonymous, signed browser session. No account
// or password is needed; existing owner projects never enter this namespace.
export function createDemoAccess(dataDir) {
  const file=join(dataDir,'demo-access.sqlite');
  const db=new DatabaseSync(file);chmodSync(file,0o600);
  db.exec('CREATE TABLE IF NOT EXISTS owners(project TEXT PRIMARY KEY, owner TEXT NOT NULL);');
  return {
    owner(headers){
      if(headers['x-event-twin-demo']!=='1')return null;
      if(headers['x-event-twin-proxy']!=='vercel'||!/^[a-f0-9]{32}$/.test(headers['x-event-twin-owner']||''))throw new AppError('데모 세션이 올바르지 않습니다.',403,'DEMO_SESSION_INVALID');
      return headers['x-event-twin-owner'];
    },
    owns:(owner,id)=>Boolean(db.prepare('SELECT 1 FROM owners WHERE owner=? AND project=?').get(owner,id)),
    register(owner,id){
      db.prepare('INSERT INTO owners VALUES (?,?)').run(id,owner);
    },
    close:()=>db.close(),
  };
}
