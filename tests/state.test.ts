import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { loadState, saveState } from '../apps/agent/src/queue/store.js';
let dir=''; afterEach(async()=>{if(dir)await rm(dir,{recursive:true,force:true})});
describe('persistent agent state',()=>{it('restores jobs and changes processing to interrupted',async()=>{dir=await mkdtemp(path.join(os.tmpdir(),'lvc-state-'));const file=path.join(dir,'state.json');await saveState({settings:{preset:'quality',outputMode:'next-to-originals',outputFolder:null},jobs:[{id:'1',inputPath:'/a',outputPath:'/b',fileName:'a',durationSeconds:1,originalSize:2,finalSize:null,progress:33,status:'processing',error:null,preset:'quality'}]},file);const restored=await loadState(file);expect(restored.settings.preset).toBe('quality');expect(restored.jobs[0].status).toBe('interrupted');expect(restored.jobs[0].error).toContain('interrupted')})});
