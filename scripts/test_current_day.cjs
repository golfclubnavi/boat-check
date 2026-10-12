// Regression against the actual view selection and LIVE merge functions.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const pairs=[['normalizedMeetDays','updateVenueSelectedDayBanner'],['currentDayView','selectMeetDay'],['mergeVenueLive','hasPendingDemoBets']];
const ctx=vm.createContext({});
for(const [name,next] of pairs){
 const start=source.indexOf(`function ${name}(`),end=source.indexOf(`function ${next}(`,start);
 assert(start>=0&&end>start);vm.runInContext(source.slice(start,end),ctx);
}
const liveRace={raceNo:12,odds:{trifecta:[{odds:5}]},boats:[{lane:1,racerId:'4347',actualST:'.15',exhibitionST:'.09'}]};
const pastRace={raceNo:12,odds:{trifecta:[{odds:8}]},boats:[{lane:1,racerId:'4347',actualST:'.18'}]};
const meeting={date:'20261012',races:[liveRace],meetDays:[{date:'20261011',races:[pastRace]},{date:'20261012',races:[{raceNo:12,boats:[{lane:1,racerId:'4347'}]}]}]};
const today=ctx.currentDayView(meeting,'20261012');
assert.strictEqual(today.races,meeting.races);assert.equal(today.races[0].odds.trifecta[0].odds,5);
assert.strictEqual(ctx.currentDayView(meeting,'20261011').races,meeting.meetDays[0].races);
ctx.mergeVenueLive(meeting,{date:'20261012',races:[{raceNo:12,odds:{trifecta:[{odds:7}]},boats:[{lane:1,racerId:'4347',exhibitionST:'.07'}]}]});
const refreshed=ctx.currentDayView(meeting,'20261012');
assert.equal(refreshed.races[0].odds.trifecta[0].odds,7);assert.equal(refreshed.races[0].boats[0].exhibitionST,'.07');assert.equal(refreshed.races[0].boats[0].actualST,'.15');
assert.equal(ctx.currentDayView(meeting,'20261011').races[0].odds.trifecta[0].odds,8);
const legacy={date:'20261012',meetDays:[{date:'20261012',races:[pastRace]}]};
assert.strictEqual(ctx.currentDayView(legacy,'20261012').races,legacy.meetDays[0].races);
console.log('[current-day] current LIVE precedence, historical preservation, immediate post-merge selection, legacy fallback: PASS (4 scenarios)');
