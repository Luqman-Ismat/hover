// Where each champion is usually played, for the position filter in champ select.
// The client doesn't expose this, so it's a hand-kept list keyed by champion alias.
// T = top, J = jungle, M = mid, B = bot, S = support. Champions not listed only show under "All".
const P = {
  Aatrox: 'T', Ahri: 'M', Akali: 'MT', Akshan: 'MT', Alistar: 'S', Ambessa: 'T', Amumu: 'JS', Anivia: 'M', Annie: 'MS',
  Aphelios: 'B', Ashe: 'BS', AurelionSol: 'M', Aurora: 'MT', Azir: 'M', Bard: 'S', Belveth: 'J', Blitzcrank: 'S',
  Brand: 'SMJ', Braum: 'S', Briar: 'J', Caitlyn: 'B', Camille: 'T', Cassiopeia: 'MT', Chogath: 'TM', Corki: 'MB',
  Darius: 'T', Diana: 'JM', DrMundo: 'TJ', Draven: 'B', Ekko: 'JM', Elise: 'J', Evelynn: 'J', Ezreal: 'B',
  FiddleSticks: 'J', Fiora: 'T', Fizz: 'M', Galio: 'MS', Gangplank: 'T', Garen: 'T', Gnar: 'T', Gragas: 'JTM',
  Graves: 'J', Gwen: 'TJ', Hecarim: 'J', Heimerdinger: 'MTS', Hwei: 'MS', Illaoi: 'T', Irelia: 'TM', Ivern: 'J',
  Janna: 'S', JarvanIV: 'J', Jax: 'TJ', Jayce: 'TM', Jhin: 'B', Jinx: 'B', Kaisa: 'B', Kalista: 'B', Karma: 'SM',
  Karthus: 'JB', Kassadin: 'M', Katarina: 'M', Kayle: 'TM', Kayn: 'J', Kennen: 'T', Khazix: 'J', Kindred: 'J',
  Kled: 'T', KogMaw: 'B', KSante: 'T', Leblanc: 'M', LeeSin: 'J', Leona: 'S', Lillia: 'JT', Lissandra: 'M',
  Lucian: 'BM', Lulu: 'S', Lux: 'SM', Malphite: 'TS', Malzahar: 'M', Maokai: 'SJT', MasterYi: 'J', Mel: 'MS',
  Milio: 'S', MissFortune: 'B', MonkeyKing: 'TJ', Mordekaiser: 'T', Morgana: 'SJ', Naafiri: 'MJ', Nami: 'S',
  Nasus: 'T', Nautilus: 'S', Neeko: 'MS', Nidalee: 'J', Nilah: 'B', Nocturne: 'J', Nunu: 'J', Olaf: 'TJ',
  Orianna: 'M', Ornn: 'T', Pantheon: 'STM', Poppy: 'TJS', Pyke: 'S', Qiyana: 'MJ', Quinn: 'T', Rakan: 'S',
  Rammus: 'J', RekSai: 'J', Rell: 'S', Renata: 'S', Renekton: 'T', Rengar: 'JT', Riven: 'T', Rumble: 'TM',
  Ryze: 'MT', Samira: 'B', Sejuani: 'J', Senna: 'SB', Seraphine: 'SB', Sett: 'TS', Shaco: 'JS', Shen: 'TS',
  Shyvana: 'J', Singed: 'T', Sion: 'T', Sivir: 'B', Skarner: 'JT', Smolder: 'BM', Sona: 'S', Soraka: 'S',
  Swain: 'SMB', Sylas: 'MJ', Syndra: 'M', TahmKench: 'TS', Taliyah: 'JM', Talon: 'MJ', Taric: 'S', Teemo: 'T',
  Thresh: 'S', Tristana: 'BM', Trundle: 'JT', Tryndamere: 'T', TwistedFate: 'M', Twitch: 'BJ', Udyr: 'JT',
  Urgot: 'T', Varus: 'B', Vayne: 'BT', Veigar: 'MB', Velkoz: 'SM', Vex: 'M', Vi: 'J', Viego: 'J', Viktor: 'M',
  Vladimir: 'MT', Volibear: 'TJ', Warwick: 'JT', Xayah: 'B', Xerath: 'SM', XinZhao: 'J', Yasuo: 'MTB', Yone: 'MT',
  Yorick: 'T', Yunara: 'B', Yuumi: 'S', Zac: 'J', Zed: 'MJ', Zeri: 'B', Ziggs: 'BM', Zilean: 'S', Zoe: 'M', Zyra: 'SJ',
};
const CODES = { T: 'TOP', J: 'JUNGLE', M: 'MIDDLE', B: 'BOTTOM', S: 'UTILITY' };
export const positionsOf = (alias) => [...(P[alias] || '')].map((c) => CODES[c]);
