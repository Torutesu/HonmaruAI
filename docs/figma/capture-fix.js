// Figma MCP `use_figma` script — clears the default white fills on the wrapper
// rows of "A5 Capture" (node 60:122) so the dark viewfinder shows through.
// Companion to classic-slack-rebuild.js; run in the same session.

const s=await figma.getNodeByIdAsync("60:122");
const mutated=[];
for(const child of s.children){
  const hasWhite=Array.isArray(child.fills)&&child.fills.some(f=>f.type==="SOLID"&&f.color.r>0.95&&f.color.g>0.95&&f.color.b>0.95);
  if(hasWhite){ child.fills=[]; mutated.push(child.id); }
}
return { mutatedNodeIds: mutated };
