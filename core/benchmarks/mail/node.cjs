const fs = require('fs');
const {load} = require('./baseline/ui/tests/load.js');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const Message = load('message/Message.js');
const Html = load('message/Html.js');
const Direction = load('message/Direction.js');
const output = {engine:process.version, cases:[]};
for (const item of input.cases) {
  const raw = Buffer.from(item.raw, 'base64url').toString('latin1');
  for (const phase of input.phases) {
    const operation = phase === 'mime' ? () => Message.parseRfc822(raw)
      : () => {
        const result=Html.sanitize(item.html, phase === "readprep" ? {withPlainText:true,withReader:true} : {});
        if(result.plainText)result.plainText.bodyDirection=Direction.resolveBody(result.plainText.text,"Auto");
        return result;
      };
    let start = process.hrtime.bigint();
    let result = operation();
    const coldUs = Number(process.hrtime.bigint()-start)/1000;
    for (let n=0;n<5;n++) result=operation();
    const samplesUs=[];
    for (let n=0;n<input.samples;n++) {
      start=process.hrtime.bigint();
      for (let j=0;j<input.batch;j++) result=operation();
      samplesUs.push(Number(process.hrtime.bigint()-start)/1000/input.batch);
    }
    if (!result || typeof result !== 'object') throw Error('Invalid operation result');
    output.cases.push({name:item.name,phase,coldUs,samplesUs,result});
  }
}
console.log(JSON.stringify(output));
