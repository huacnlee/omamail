"""Generate an actual Qt QML-JS runner against the frozen production libraries."""
import json


def source(payload, baseline):
    text='''import QtQml
import "MESSAGE" as Message
import "HTML" as Html
import "DIRECTION" as Direction
QtObject {
  property var input: PAYLOAD
  Component.onCompleted: {
    var output={engine:"Qt QML JavaScript",timerResolutionUs:1000,cases:[]}
    for(var i=0;i<input.cases.length;i++) {
      var item=input.cases[i]
      var raw=Message.bytesToLatin1(Message.base64ToBytes(item.raw))
      for(var p=0;p<input.phases.length;p++) {
        var phase=input.phases[p]
        var operation=phase==="mime" ? function(){return Message.parseRfc822(raw)}
          : function(){
            var prepared=Html.sanitize(item.html,phase === "readprep" ? {withPlainText:true,withReader:true} : {})
            if(prepared.plainText)prepared.plainText.bodyDirection=Direction.resolveBody(prepared.plainText.text,"Auto")
            return prepared
          }
        var start=Date.now()
        var result=operation()
        var coldUs=(Date.now()-start)*1000
        for(var w=0;w<5;w++) result=operation()
        // Calibrate batches to >=20ms to bound millisecond timer quantization.
        var batch=1
        var elapsed=0
        while(batch<=2048) {
          start=Date.now()
          for(var j=0;j<batch;j++) result=operation()
          elapsed=Date.now()-start
          if(elapsed>=20 || batch>=2048) break
          batch*=2
        }
        var samples=[]
        for(var n=0;n<input.samples;n++) {
          start=Date.now()
          for(var j=0;j<batch;j++) result=operation()
          samples.push((Date.now()-start)*1000/batch)
        }
        if(!result || typeof result!=="object") throw new Error("Invalid benchmark result")
        output.cases.push({name:item.name,phase:phase,coldUs:coldUs,samplesUs:samples,batch:batch,result:result})
      }
    }
    console.log("OMAMAIL_BENCH_RESULT "+JSON.stringify(output))
    Qt.exit(0)
  }
}
'''
    return text.replace('MESSAGE',(baseline/'message/Message.js').as_uri()).replace('HTML',(baseline/'message/Html.js').as_uri()).replace('DIRECTION',(baseline/'message/Direction.js').as_uri()).replace('PAYLOAD',json.dumps(payload,ensure_ascii=True))
