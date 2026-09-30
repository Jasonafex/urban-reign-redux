"""Visual-only native upper-body electricity, scoped per actor and action start."""
import sys,struct,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from combat_routing import Asm
W=Path(__file__).resolve().parent;CODE=0x20a6800;STATE=0x20a6b00;HOOK=0x2a24f8
def build():
 a=Asm(CODE);a.i(9,29,29,-32);a.i(63,31,29,24);a.call(0x20b0440);a.i(43,2,29,0)
 a.li(8,0x6646f0);a.li(4,0)
 a.label('find');a.b(4,8,2,'found');a.i(9,8,8,20);a.i(9,4,4,1);a.i(11,9,4,8);a.b(5,9,0,'find');a.b(4,0,0,'done')
 a.label('found');a.r(0,9,0,4,2);a.li(10,0x59d168);a.r(0x21,10,10,9);a.i(35,10,10,0);a.b(4,10,0,'done')
 a.r(0,9,0,4,4);a.li(11,STATE);a.r(0x21,11,11,9);a.i(35,9,10,4);a.li(12,16);a.b(5,9,12,'reset')
 a.li(9,0x8d40);a.r(0x21,9,10,9);a.i(35,12,9,0);a.i(35,13,11,0);a.i(43,12,11,0)
 # Restart detection also handles consecutive activations of the same action.
 a.i(49,0,10,0x54);a.i(49,1,11,4);a.i(57,0,11,4)
 a.b(5,12,13,'changed');a.words.append(0x4601003c) # c.lt.s f0,f1
 a.fix.append((len(a.words),'done'));a.words.extend([0x45000000,0]) # bc1f
 a.label('changed');repeat=json.loads((W/'contact-followup-report.json').read_text())['kazuya_electric_repeat'];a.li(13,repeat);a.b(4,12,13,'ewgf');a.li(13,3972);a.b(4,12,13,'ewgf');a.li(13,3973);a.b(5,12,13,'done');a.li(7,62);a.b(4,0,0,'emit')
 a.label('ewgf');a.li(7,14)
 a.label('emit');a.i(43,11,29,8);a.li(5,1);a.li(6,1);a.call(0x188970);a.i(35,11,29,8);a.i(43,2,11,8);a.i(35,9,11,12);a.i(9,9,9,1);a.i(43,9,11,12);a.b(4,0,0,'done')
 a.label('reset');a.i(43,0,11,0);a.i(43,0,11,4)
 a.label('done');a.i(35,2,29,0);a.i(55,31,29,24);a.i(9,29,29,32);a.ret()
 code=a.finish();assert len(code)<=STATE-CODE
 return code,struct.pack('<I',0x0c000000|CODE//4)
if __name__=='__main__':
 code,hook=build();(W/'effect-code.bin').write_bytes(code);(W/'effect-hook.json').write_text(json.dumps({'address':HOOK,'before':0x0c000000|0x20b0440//4,'after':struct.unpack('<I',hook)[0],'code_address':CODE,'state_address':STATE,'state_bytes':128,'code_bytes':len(code),'actions':{'3972':14,'3973':62},'health_or_injury_writes':False},indent=2));print(len(code))
