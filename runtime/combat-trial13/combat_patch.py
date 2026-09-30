"""Append-only combat records, scoped attack roots, and audited relocations."""
from pathlib import Path
import sys,struct,json
R=Path(__file__).resolve().parent;T=R.parent
OLD=T/'revision7'
sys.path.insert(0,str(T))
from idle_routing import Asm
from ur_actions import ACTION,REACTION,HIT,BRANCH,action
NEW={'action':0x25016f0,'reaction':0x255b768,'hit':0x25fe5a0,'branch':0x26138d8}
ROOT_HOOK=0x20b1000;SPA_HOOK=0x20b2000
CHAR={'Violet':54,'Kazuya':16,'Dragunov':36,'Kiryu':46,'Hwoarang':41,'Bryan':43,'Leon':0,'Jin':15,'Cammy':31,'Jack5':45,'Heihachi':53,'King':19,'Armor Queen':58}

def build():
 ram=(OLD/'runtime/Violet-scaled-fresh/eeMemory.bin').read_bytes()
 actions=bytearray(ram[ACTION:ACTION+3950*64])
 ac=[action(ram,i) for i in range(3950)]
 nr=max(a['reaction_index'] for a in ac)+1
 reactions=bytearray(ram[REACTION:REACTION+236*nr])
 nh=max(struct.unpack_from('<H',reactions,i*236+0xc0)[0]+struct.unpack_from('<H',reactions,i*236+0xc2)[0] for i in range(nr))
 hits=bytearray(ram[HIT:HIT+18*nh]);nb=max(a['branch_index']+len(a['branches']) for a in ac)
 branches=bytearray(ram[BRANCH:BRANCH+30*nb]);manifest=[];ids={};banks=[]
 source={(('Violet' if m['character']=='Lee' else m['character']),m['id']):m for m in json.loads((OLD/'attack-source-manifest.json').read_text())}
 def clone(name,key,native):
  aid=len(actions)//64;ids[name,key]=aid;actions.extend(ram[ACTION+native*64:ACTION+(native+1)*64]);manifest.append(dict(character=name,key=key,id=aid,native_template=native))
  # New records must never fall through to the original multi-hit extension.
  struct.pack_into('<hh',actions,aid*64+4,-2,0);struct.pack_into('<HH',actions,aid*64+0x32,0,0)
  return aid
 def stage(name,num,template,limb):
  m=source[name,num];aid=clone(name,num,template);record=bytearray(reactions[ac[template]['reaction_index']*236:(ac[template]['reaction_index']+1)*236]);ri=len(reactions)//236;hi=len(hits)//18
  height={15:2,18:0,23:1}.get(m['hitlevel']&255,1)
  # Native palette capsules follow the imported animated limb. The source
  # collision byte names limb endpoints, not transferable world coordinates.
  endpoints={'RH':[9,8],'LH':[13,12],'RF':[17,15],'LF':[21,19]}[limb]
  hits.extend(struct.pack('<9h',*m['active'],m['damage'],height,*endpoints,-1,-1,-1));struct.pack_into('<HHH',record,0xc0,hi,1,height);reactions.extend(record)
  end=m['recovery_to_neutral'][0] if m['recovery_to_neutral'] else m['frames']-1
  struct.pack_into('<h',actions,aid*64,0);struct.pack_into('<h',actions,aid*64+8,end);struct.pack_into('<H',actions,aid*64+0x38,ri)
  # Imported banks carry their own recovery; discard template timed effects.
  for off in [0x28,0x2c]:struct.pack_into('<I',actions,aid*64+off,0)
  struct.pack_into('<H',actions,aid*64+0x30,0);struct.pack_into('<HH',actions,aid*64+0x3c,0,0)
  banks.append((CHAR[name],0x10000+aid,(OLD/'attack-retargets'/f'{name}-{num}.gyu').read_bytes()))
  manifest[-1].update(source_move=m['name'],active=m['active'],damage=m['damage'],recovery=end,limb=limb,source_frames=m['frames'])
  return aid
 def chain(name,key,nextkey,window,commit,additional=None):
  aid=ids[name,key];dest=ids[name,nextkey];start,end=window
  # UR evaluates continuation before contact: keep the last active frame.
  hit_end=source[name,key]["active"][1] if isinstance(key,int) else max(h[1] for h in ac[next(x for x in manifest if x["id"]==aid)["native_template"]]["hits"])
  if name=='Violet' and key=='side':hit_end=26
  commit=max(commit,hit_end+1);end=max(end,commit)
  rr=[[dest,0,0,57,start,end,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,commit,end,0,0,0,0,0,0,0,0,0]]
  if additional:
   target,ws,we,at=additional;rr.insert(1,[ids[name,target],0,0,57,ws,we,43,0,0,0,0,0,0,0,0]);rr[-1][5]=max(end,we)
  bi=len(branches)//30
  for r in rr:branches.extend(struct.pack('<15h',*r))
  struct.pack_into('<HH',actions,aid*64+0x32,bi,len(rr))
  next(x for x in manifest if x['id']==aid)['continuation']=rr
 for name,keys in [('Violet',[('native1',2785),('native2',2786),('side',2045)]),('Kazuya',[('native1',2115),('native2',2116)])]:
  for key,native in keys:clone(name,key,native)
 # Keep both automatic kicks of the original Lin Fong side input.
 side=ids['Violet','side'];ri=len(reactions)//236;hi=len(hits)//18
 rec=bytearray.fromhex(ac[2045]['reaction_raw'])
 for h in ac[2045]['hits']+ac[2046]['hits']:hits.extend(struct.pack('<9h',*h))
 struct.pack_into('<HH',rec,0xc0,hi,2);reactions.extend(rec)
 struct.pack_into('<hh',actions,side*64+6,0,57);struct.pack_into('<H',actions,side*64+0x38,ri)
 for n in [386,387,388,390,392]:stage('Violet',n,2116,'LF')
 stage('Violet',393,2787,'RF');stage('Violet',457,2786,'RH');stage('Violet',507,2787,'LF')
 for n in [413,493,494,495,497,460]:stage('Violet',n,2117 if n in [413,493,494,495] else 2787,'RF')
 stage('Violet',486,2117,'LF')
 for n,template,limb in [(522,2117,'RF'),(527,1220,'LH'),(494,1220,'RH'),(428,2422,'LH'),(521,2117,'RF'),(439,2787,'LF')]:stage('Kazuya',n,template,limb)
 for n,template,limb in [(362,2785,'LH'),(369,2786,'RH'),(371,2785,'LH')]:stage('Dragunov',n,template,limb)
 # Replace only Reggie's directional up SPA; retain its 175 damage and cost.
 spa_id=ids['Kazuya',428]
 actions[spa_id*64+0xc:spa_id*64+0x14]=ram[ACTION+2001*64+0xc:ACTION+2001*64+0x14]
 sri=struct.unpack_from('<H',actions,spa_id*64+0x38)[0];shi=struct.unpack_from('<H',reactions,sri*236+0xc0)[0]
 original_spa=bytearray.fromhex(ac[2001]['reaction_raw']);struct.pack_into('<HHH',original_spa,0xc0,shi,1,1)
 reactions[sri*236:(sri+1)*236]=original_spa;struct.pack_into('<h',hits,shi*18+4,ac[2001]['hits'][0][2])
 next(m for m in manifest if m['id']==spa_id).update(damage=ac[2001]['hits'][0][2],spa_cost=struct.unpack_from('<I',actions,spa_id*64+0x10)[0],replaces_native_spa=2001)
 chain('Violet','native1','native2',(1,25),12);chain('Violet','native2',457,(1,30),15);chain('Violet',457,507,(1,38),25)
 chain('Violet','side',386,(1,42),28)
 for first,last,commit in [(386,387,16),(387,388,9),(388,390,9),(390,392,10),(392,393,10)]:chain('Violet',first,last,(1,commit+12),commit)
 # Early repeated input selects Laser Edge; a later follow-up selects the
 # alternate d+4,4,3,4 branch while still allowing the first kick to recover.
 chain('Violet',413,494,(1,12),12,additional=(493,13,23,13))
 for first,last,end,commit in [(494,495,30,20),(495,497,34,20),(493,486,23,23),(486,460,18,18)]:chain('Violet',first,last,(1,end),commit)
 chain('Kazuya','native1','native2',(1,35),25);chain('Kazuya','native2',521,(1,40),30);chain('Kazuya',521,439,(1,40),28);chain('Kazuya',522,527,(1,16),16)
 chain('Dragunov',362,369,(1,10),10);chain('Dragunov',369,371,(1,18),18)
 clone('Kazuya','native3',2117);clone('Kazuya','roundhouse',1220)
 chain('Kazuya','native2','native3',(1,40),30);chain('Kazuya','native3',521,(1,42),30)
 chain('Kazuya',494,'roundhouse',(1,40),max(source['Kazuya',494]['active'])+6)
 # a2=3 is running attack; the authored Kadonashi jumping kick is1694.
 mapping=[(54,0,0,ids['Violet','native1']),(54,2,-1,ids['Violet',413]),(54,3,-1,ids['Violet','side']),
 (16,0,0,ids['Kazuya','native1']),(16,2,-1,ids['Kazuya',522]),(16,1,-1,ids['Kazuya',494]),(16,0,3,1694)]
 from extra_actions import append_actions
 append_actions(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,CHAR,clone,ac,R)
 from automatic_hits import split
 split(ram,actions,reactions,hits,branches,manifest,ids,banks,clone,ac,CHAR,R)
 from throw_patch import append_throw
 throw_chunks=append_throw(ram,actions,manifest,ids,banks,clone,R)
 from refinements import apply
 link=apply(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,CHAR,clone,ac,R)
 from balance import apply as balance
 spa_rows=balance(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,CHAR,clone,ac,R,link)
 from followup import apply as followup
 followup(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,CHAR,clone,ac,R,spa_rows)
 from contact_followup import apply as contact_followup
 radius,protected=contact_followup(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,CHAR,clone,ac,R,spa_rows)
 from remaining_moves import apply as remaining
 green=remaining(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,CHAR,clone,ac,R,spa_rows,radius,protected)
 from jack_latest import apply as jack_latest
 jack_latest(actions,reactions,hits,branches,manifest,banks,mapping,ac,R,radius)
 # September 29 feedback: restore Hwoarang's native up/down roots.
 mapping[:]=[row for row in mapping if not (row[0]==41 and row[1] in (1,2))]
 # User's Park back-turned up attack capture identifies native action 1783,
 # reaction 665: victims 96/95, the high launcher (not the low corkscrew).
 # Preserve each imported strike's collision, damage, hit level and sounds.
 high_launchers=[3972,4171,4174,4012,4037,4084,4097,4202,4235,4243,4245,4261]
 for aid in high_launchers:
  ri=struct.unpack_from('<H',actions,aid*64+0x38)[0]
  old=reactions[ri*236:(ri+1)*236];rec=bytearray(old)
  rec[:0xc0]=bytes.fromhex(ac[1783]['reaction_raw'])[:0xc0]
  struct.pack_into('<H',actions,aid*64+0x38,len(reactions)//236);reactions.extend(rec)
  next(m for m in manifest if m['id']==aid).update(hit_class='launch',launch_height='high',standing_victim_reactions=[96,95],native_reference_action=1783)
 from gigaton_charge import append as charge
 charge_chunks,charge_hooks=charge(actions,reactions,hits,branches,manifest,banks,clone,R,spa_rows,protected)
 # Jin's native green SPA2 takes a short miss exit at 2926. Keep its full
 # authored sequence even if the opening misses, without changing Kadonashi.
 jin_native=[2925,2926,*range(2912,2920)]
 jin_spa={n:clone('Jin','Green SPA2 full sequence '+str(n),n) for n in jin_native}
 for n,aid in jin_spa.items():
  actions[aid*64:(aid+1)*64]=bytes.fromhex(ac[n]['raw'])
  rr=[list(row) for row in ac[n]['branches']]
  if n==2926:
   rr=[row for row in rr if row[0]==2912]
   assert len(rr)==1
   rr[0][2]=-10
   struct.pack_into('<h',actions,aid*64+4,-2)
  for row in rr:row[0]=jin_spa.get(row[0],row[0])
  bi=len(branches)//30
  for row in rr:branches.extend(struct.pack('<15h',*row))
  struct.pack_into('<HH',actions,aid*64+0x32,bi,len(rr))
  protected.append(aid)
  next(m for m in manifest if m['id']==aid).update(spa=True,spa_protection=True,continuation=rr,native_motion_preserved=True)
 (R/'jin-green-spa-fix.json').write_text(json.dumps(dict(actions=jin_spa,miss_exit_removed=2928,runtime_verified=False),indent=2))
 # Imported terminal attack states retain control until their native end.
 # SPA input normally bypasses this and can cut off even a required kip-up.
 terminal=[]
 bank_ids={k-0x10000 for c,k,b in banks if k>=0x10000}
 for aid in sorted(bank_ids):
  state=struct.unpack_from('<h',actions,aid*64+2)[0]
  nxt=struct.unpack_from('<h',actions,aid*64+4)[0]
  bi,bn=struct.unpack_from('<HH',actions,aid*64+0x32)
  destinations=[struct.unpack_from('<h',branches,(bi+j)*30)[0] for j in range(bn)]
  if state==6 and nxt<0 and not any(x>=0 for x in destinations):terminal.append(aid)
 guard=Asm(0x2490200);guard.i(11,8,4,8);guard.b(4,8,0,'allow')
 guard.r(0,8,0,4,2);guard.li(9,0x59d168);guard.r(0x21,8,8,9);guard.i(35,8,8,0);guard.b(4,8,0,'allow')
 guard.li(9,0x8d40);guard.r(0x21,8,8,9);guard.i(35,8,8,0);guard.li(9,0x2490600)
 guard.label('scan');guard.i(35,10,9,0);guard.i(9,11,0,-1);guard.b(4,10,11,'allow');guard.b(4,8,10,'block')
 guard.i(9,9,9,4);guard.b(4,0,0,'scan');guard.label('block');guard.i(9,2,0,1);guard.ret();guard.label('allow');guard.move(2,0);guard.ret()
 guard_data=struct.pack('<'+'i'*(len(terminal)+1),*terminal,-1)
 assert len(guard.finish())<=0x400 and len(guard_data)<=0xa00
 charge_chunks.extend([(guard.base,guard.finish()),(0x2490600,guard_data)])
 (R/'terminal-spa-guard.json').write_text(json.dumps(dict(actions=terminal,scope='imported terminal attacks only',runtime_verified=False),indent=2))
 def wrapper(address,original,rows):
  a=Asm(address);a.i(9,29,29,-32);a.i(63,31,29,24)
  for reg,off in [(4,0),(5,4),(6,8)]:a.i(43,reg,29,off)
  if original==0x213748:
   a.call(guard.base);a.b(4,2,0,'can_start');a.i(9,2,0,-1);a.b(4,0,0,'done');a.label('can_start')
   for reg,off in [(4,0),(5,4),(6,8)]:a.i(35,reg,29,off)
  a.call(original);a.i(35,8,29,0);a.r(0,8,0,8,2);a.li(9,0x59d168);a.r(0x21,8,8,9);a.i(35,8,8,0)
  # Weapon and power-up styles must retain their native roots. In particular
  # Jin's green extension style returns to Kadonashi's complete native set.
  a.li(9,0x8d86);a.r(0x21,9,8,9);a.i(37,10,9,0);a.i(37,11,9,2)
  if original==0x213840:
   a.b(4,10,11,'normal_style')
   # Native style selection at 0x2462e8 tests buff 3 and loads +0x8d8a;
   # +0x8d94 is a weapon style, and +0x93c0 is not the buff state.
   # Match the actor's actual green style after excluding the base style.
   a.i(37,12,9,4);a.b(5,10,12,'done')
   a.i(9,14,0,1);a.b(4,0,0,'style_ready');a.label('normal_style');a.i(9,14,0,0);a.label('style_ready')
  else:
   a.b(4,10,11,'spa_base_style')
   a.i(37,12,9,4);a.b(5,10,12,'done')
   a.i(35,12,8,4);a.i(9,13,0,15);a.b(5,12,13,'done')
   a.i(35,12,29,4);a.i(9,13,0,3);a.b(5,12,13,'done')
   a.i(9,2,0,jin_spa[2925]);a.b(4,0,0,'done');a.label('spa_base_style')
  a.i(35,8,8,4)
  a.i(35,9,29,4);a.i(35,10,29,8)
  for i,(char,group,bearing,target) in enumerate(rows+(green if original==0x213840 else [])):
   label=f'next{i}';a.i(9,11,0,char);a.b(5,8,11,label);a.i(9,11,0,group);a.b(5,9,11,label)
   if original==0x213840:
    if i<len(rows):a.b(5,14,0,label)
    else:a.b(4,14,0,label)
   if original==0x213840:
    if bearing<0:a.i(11,11,10,3);a.b(4,11,0,label)
    else:a.i(9,11,0,bearing);a.b(5,10,11,label)
   a.i(9,2,0,target);a.b(4,0,0,'done');a.label(label)
  a.label('done');a.i(55,31,29,24);a.i(9,29,29,32);a.ret();return a.finish()
 chunks=[(NEW[k],b) for k,b in [('action',actions),('reaction',reactions),('hit',hits),('branch',branches)]]
 chunks.extend(throw_chunks);chunks.extend(charge_chunks)
 chunks += [(ROOT_HOOK,wrapper(ROOT_HOOK,0x213840,mapping)),(SPA_HOOK,wrapper(SPA_HOOK,0x213748,[(16,1,-1,ids['Kazuya',428])]+spa_rows))]
 # UR tests a zero-width limb segment against victim spheres. Imported DR
 # strikes need finite limb thickness; expand a stack copy of the victim
 # sphere for this single query, never the live victim or native attacks.
 c=Asm(0x20b0800);c.i(9,29,29,-64);c.i(63,31,29,48)
 c.li(8,0x59d168);c.i(9,9,0,8)
 c.label('scan_actor');c.i(35,10,8,0);c.li(11,0x8f10);c.r(0x21,11,10,11);c.r(0x23,11,4,11)
 c.i(11,12,11,0xa0);c.b(5,12,0,'actor');c.i(9,8,8,4);c.i(9,9,9,-1);c.b(5,9,0,'scan_actor');c.b(4,0,0,'native')
 c.label('actor');c.li(11,0x8d40);c.r(0x21,10,10,11);c.i(35,10,10,0);c.i(9,10,10,-3955);c.i(11,11,10,len(actions)//64-3955);c.b(4,11,0,'native')
 for off in range(0,32,4):c.i(35,11,5,off);c.i(43,11,29,off)
 c.li(11,struct.unpack('<I',struct.pack('<f',.28))[0])
 c.li(15,struct.unpack('<I',struct.pack('<f',1.0))[0])
 # Piston Gun: scale the entire adapted collision radius, including the
 # native radius, by 50%; scaling only the extra allowance undershoots it.
 piston=[m['id'] for m in manifest if m['character']=='Jack5' and 'Piston' in m.get('label','')]
 for aid in piston:
  c.i(9,12,10,-(aid-3955));c.b(4,12,0,'piston_radius')
 c.b(4,0,0,'ordinary_radius');c.label('piston_radius')
 c.li(15,struct.unpack('<I',struct.pack('<f',1.5))[0]);c.b(4,0,0,'radius_ready');c.label('ordinary_radius')
 # The two special 0x6e Acid Storm sweep volumes need a wider arc.
 c.i(9,12,10,-3);c.i(11,12,12,2);c.b(4,12,0,'check_electric')
 c.li(11,struct.unpack('<I',struct.pack('<f',.32))[0]);c.b(4,0,0,'radius_ready')
 c.label('check_electric');c.i(9,12,10,-(ids['Kazuya',521]-3955));c.i(11,12,12,2);c.b(4,12,0,'electric')
 c.li(11,struct.unpack('<I',struct.pack('<f',.46))[0]);c.b(4,0,0,'radius_ready')
 c.label('electric');c.i(9,12,10,-(ids['Kazuya',494]-3955));c.b(5,12,0,'radius_ready')
 c.li(11,struct.unpack('<I',struct.pack('<f',.35))[0]);c.label('radius_ready')
 radius_table=0x20b3c00
 radius_data=b''.join(struct.pack('<if',aid-3955,factor) for aid,factor in radius.items())+struct.pack('<if',-1,1.)
 assert len(radius_data)<=0x400
 chunks.append((radius_table,radius_data))
 c.li(13,radius_table);c.label('radius_scan');c.i(35,12,13,0);c.i(9,14,0,-1);c.b(4,12,14,'scaled_radius')
 c.b(4,12,10,'radius_match');c.i(9,13,13,8);c.b(4,0,0,'radius_scan')
 c.label('radius_match');c.i(35,15,13,4)
 c.label('scaled_radius');c.words += [0x448b0800]
 c.i(49,0,29,0x14);c.words += [0x46010000,0x448f1800,0x46030002,0x46000082]
 c.i(57,0,29,0x14);c.i(57,2,29,0x10);c.move(5,29)
 c.label('native');c.call(0x259398);c.i(55,31,29,48);c.i(9,29,29,64);c.ret()
 assert len(c.finish())<=0x800;chunks.append((c.base,c.finish()))
 elf=(T/'installed.elf').read_bytes();hooks={};audit=json.loads((OLD/'table-relocation-audit.json').read_text())
 for name,refs in audit.items():
  upper=(NEW[name]+0x8000)>>16
  for addr in refs:
   a=int(addr,16);old=struct.unpack_from('<I',elf,a-0xff000)[0];hooks[a]=(old,(old&0xffff0000)|upper)
 for a in range(0x100000,0x300000,4):
  old=struct.unpack_from('<I',elf,a-0xff000)[0]
  for original,new in [(0x213840,ROOT_HOOK),(0x213748,SPA_HOOK)]:
   if old==0x0c000000|original//4:hooks[a]=(old,0x0c000000|new//4)
 hooks[0x2594a4]=(0x0c000000|0x259398//4,0x0c000000|c.base//4)
 from voice_patch import voice_patch
 vc,vh=voice_patch(manifest,ids);chunks.extend(vc);hooks.update(vh)
 from grab_patch import grab_patch
 gc,gh=grab_patch(ram,elf,ids);chunks.extend(gc);hooks.update(gh)
 from spa_protection import protection
 pc,ph=protection(elf,protected);chunks.extend(pc);hooks.update(ph)
 from throw_patch import hooks as throw_hooks
 hooks.update(throw_hooks(elf));hooks.update(charge_hooks)
 for i,(a,b) in enumerate(chunks):
  for c,d in chunks[:i]:assert a+len(b)<=c or c+len(d)<=a,(hex(a),hex(c))
 (R/'combat-manifest.json').write_text(json.dumps(dict(actions=manifest,counts=dict(action=len(actions)//64,reaction=len(reactions)//236,hit=len(hits)//18,branch=len(branches)//30),native_counts=dict(action=3950,reaction=nr,hit=nh,branch=nb),root_mapping=mapping,source_timing=True,engine_collision_adaptation=True,validated_in_game=False),indent=2))
 print('Combat actions',len(manifest),'hooks',len(hooks),'new bank rows',len(banks))
 return chunks,hooks,banks
if __name__=='__main__':build()
