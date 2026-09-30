"""User-requested Trial 8 chains. Each nested group is one button input.

Multiple source records in one group are automatic hits of one animation.
Source transition starting frames are retained by the preparation script.
"""
ENTRIES={'Lee':1873,'Kazuya':1841,'Dragunov':2529,'Raven':2385,
         'Asuka':2209,'Bryan':1777,'Hwoarang':1489,'Jin':1665,
         'Julia':1713,'Nina':1457,'Jack5':2017}

def move(label,source,ids,limbs,automatic=False,finish=None):
    assert len(ids)==len(limbs)
    groups=[list(zip(ids,limbs))] if automatic else [[p] for p in zip(ids,limbs)]
    return dict(label=label,source=source,groups=groups,finish=finish)

CHAINS={
 ('Dragunov','side'):[
  move("Death's Door",'Dragunov',[446,550,552],['RH','LH','RH']),
  move('Cougar Maul','Dragunov',[398,399],['RF','RF']),
  move('War Machine','Dragunov',[487,490],['RF','LF'])],
 ('Kiryu','up'):[
  move("Unicorn's Tail",'Raven',[453,457,468],['RH','RH','LF']),
  move('Iron Flail','Dragunov',[347],['RF'],finish='knockback')],
 ('Kiryu','neutral'):[
  move('Gatling Combination','Bryan',[409,530,531,552],['LF','RH','LH','RF']),
  move('Karnov Kick','Dragunov',[386,387],['RF','LF'])],
 ('Kiryu','side'):[
  move('Chakram','Raven',[582,587,588],['LF','RF','RH']),
  move('Double Lift Kick (Kazama)','Asuka',[389,441],['LF','RF'],automatic=True)],
 ('Hwoarang','side'):[
  move('Home Surgery','Hwoarang',[369,577,589,590],['LH','LH','LF','LF']),
  move('Total Outrage','Hwoarang',[377,582,585,645,609],['LF','LF','LF','RF','RF'])],
 ('Hwoarang','down'):[
  move('Firecracker','Hwoarang',[441,627],['RF','RF']),
  move('Tsunami Kick','Hwoarang',[464,549],['RF','RF'])],
 ('Hwoarang','up'):[move('Hunting Hawk','Hwoarang',[481,614,584],['LF','RF','LF'])],
 ('Bryan','side'):[
  move('Vulcan Cannon','Bryan',[474,501,502,503],['LH']*4),
  move('Double Body Blow','Bryan',[474,504],['LH','RH']),
  move("Lair's Dance",'Bryan',[369,560,513,512,508],['LH','RF','RH','LH','RH'])],
 ('Bryan','neutral'):[
  move('Mid Kick to Rush','Bryan',[409,530,531,545],['LF','RH','LH','RH']),
  move('Python Crush','Bryan',[597,601],['RH','LF'])],
 ('Bryan','up'):[move('Anaconda Bite','Bryan',[409,572,593],['LF','LF','RH'],finish='launch')],
 ('Leon','side'):[
  move('Right Reverse Kick Combo','Hwoarang',[552,562,654],['RH','RF','RF'],finish='stagger'),
  move('Rocket Launcher','Hwoarang',[594,585,586],['LF','LF','LF'],finish='launch'),
  move('Chainsaw Kick Combo','Hwoarang',[552,562,657],['RH','RF','LF'])],
 ('Leon','neutral'):[
  move('Running Blind','Bryan',[369,560,561,571],['LH','RF','LF','LF']),
  move('PK Combination','Bryan',[402,404],['RH','LF']),
  move('Quick Spin Kick','Bryan',[409,572],['LF','LF'])],
 ('Jin','side'):[
  move('Kazama Style 5 Hit Combo','Jin',[342,346,349,354,357],['LH','LF','RH','LH','RF']),
  move('Savage Sword','Jin',[540,541,542],['RH','RH','LF'])],
 ('Jin','neutral'):[
  move('Knee Popper to Sidekick','Jin',[467,468],['LF','LF']),
  move('Thrust to Roundhouse','Jin',[481,490],['LH','RF']),
  move('Double Chamber Punch','Jin',[497,498],['RH','LH'],automatic=True)],
 ('Cammy','neutral'):[
  move('Right Backfist to Left Roundhouse','Jin',[430,431],['RH','LF']),
  move('Suigetsu Strike','Jin',[372],['RH']),
  move('Evil Intent','Jin',[548,550,551],['RH','LH','RH'])],
 ('Cammy','up'):[
  move('Thrusting Uppercut','Jin',[568],['LH'],finish='launch'),
  move('Bow & Arrow Sweep','Julia',[346,446,487,488],['LH','LH','RF','LF'])],
 ('Cammy','side'):[
  move('Mountain Crusher','Julia',[507,509,514],['RF','RH','LH'],finish='stagger'),
  move('Spinning Kicks Slash Uppercut','Julia',[359,482,453],['RF','RF','LH'])],
 ('Cammy','down'):[
  move("PK Combo to Assassin's Blade",'Nina',[358,359,360],['LH','RF','LH']),
  move('Wipe the Floor','Nina',[534],['RF'])],
 ('Jack5','neutral'):[
  move('Rushing Uppercut Left','Jack5',[405,462,444,466],['LH','RH','LH','RH']),
  move('Double Hammer','Jack5',[362,477],['LH','RH'])],
 ('Jack5','side'):[
  move('Cemaho Chop','Jack5',[549],['RH']),
  move('Piston Gun','Jack5',[380,381,382,383,384],['RH','RH','RH','RH','RH'],automatic=True,finish='stagger'),
  move('Rocket Uppercut','Jack5',[578],['RH'],finish='launch')],
}

TWEAKS={
 'directions':'Violet Laser Edge and Kazuya hellsweep down; EWGF up',
 'kazuya_ewgf_collision_scale':2.5,'kazuya_ewgf_voice':'Heavy 1',
 'kazuya_running_neutral':'Kadonashi jumping kick',
 'kazuya_ewgf_followup':'native Reggie up roundhouse',
 'kazuya_neutral_native_hits':3,
 'violet_side_native_opener_hits':2,'violet_input_timing':'more forgiving',
 'attack_voices':'occasional native character voice events',
 'kazuya_up_spa':'spinning uppercut, retain native damage and gauge cost',
 'cammy_grabs':'native submission throws',
 'jack5_default_throw':'Rotary Catapult with paired victim animation',
 'violet_special_attacks':'unchanged native special attacks',
 'kiryu_side_substitution':'Double Lift Kick (Kazama) replaces Poison Needle',
}
