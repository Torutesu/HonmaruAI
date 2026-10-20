import { expect, test } from 'vitest';
import { skillPackagePath, validateSkillPackage, MAX_SKILL_ASSET_BYTES } from '../src/harness/skillPackage.js';
const bytes = text => new TextEncoder().encode(text);
const root = () => ({path:'SKILL.md',bytes:bytes('---\nname: reports\ndescription: Build reports\n---\nRead templates/report.md before writing.')});
test.each(['../secret','/etc/passwd','a/../b','a\\b','C:/file','a//b','a/./b','a\0b','a/','CON.txt','templates/NUL','a.','a ','e\u0301.txt'])('rejects ambiguous or escaping package path %s',path=>{
 expect(skillPackagePath(path)).toBeNull();
});
test('preserves support file bytes and validates the root instructions',()=>{
 const image=new Uint8Array([0,255,128,1]);
 const result=validateSkillPackage([root(),{path:'templates/report.md',bytes:bytes('Report template')},{path:'images/chart.png',bytes:image}]);
 expect(result.draft).toMatchObject({name:'reports'});
 expect(result.files.map(file=>file.path)).toEqual(['templates/report.md','images/chart.png']);
 expect(result.files[1].bytes).toEqual(image);
});
test('rejects links, case collisions, directory conflicts, missing roots and invalid UTF-8',()=>{
 for (const entries of [
  [root(),{path:'link',kind:'symlink',bytes:bytes('secret')}],
  [root(),{path:'skill.md',bytes:bytes('duplicate')}],
  [root(),{path:'templates',bytes:bytes('x')},{path:'templates/a.txt',bytes:bytes('x')}],
  [{...root(),path:'folder/SKILL.md'}],
  [{path:'SKILL.md',bytes:new Uint8Array([255])}],
 ]) expect(validateSkillPackage(entries).error).toBeTruthy();
});
test('enforces decoded file count and byte limits',()=>{
 expect(validateSkillPackage([root(),{path:'large',bytes:new Uint8Array(MAX_SKILL_ASSET_BYTES+1)}]).error).toBeTruthy();
 expect(validateSkillPackage([root(),...Array.from({length:64},(_,i)=>({path:`f${i}`,bytes:bytes('x')}))]).error).toBeTruthy();
 expect(validateSkillPackage([root(),...Array.from({length:8},(_,i)=>({path:`f${i}`,bytes:new Uint8Array(MAX_SKILL_ASSET_BYTES)}))]).error).toBeTruthy();
});
