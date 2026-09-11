import QtQuick
import QtTest
import "../../components" as Omamail

Item {
  width: 640
  height: 160
  Omamail.MessageRow {
    id: row
    width: 600
    textColor: Qt.rgba(1, 1, 1, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    dimColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    panelFontFamily: "monospace"
    summary: ({id:"one",subject:"Title",from:{display:"Sender"},snippet:"Description",time:"09:14",unread:true,starred:false})
  }
  TestCase {
    name: "MessageRowLayout"
    when: windowShown
    function test_sender_and_time_lead_title_and_description_data() {
      return [{tag:"normal",width:600,actions:false,source:"",conversation:false},
        {tag:"actions",width:360,actions:true,source:"",conversation:false},
        {tag:"unified-conversation",width:360,actions:true,source:"Personal mailbox with a long name",conversation:true},
        {tag:"selected",width:360,actions:true,source:"",conversation:false,checked:true},
        {tag:"rtl",width:360,actions:false,source:"",conversation:false,rtl:true}]
    }
    function test_sender_and_time_lead_title_and_description(data) {
      row.width=data.width
      row.hasCursor=data.actions
      row.conversations=data.conversation
      row.checked=!!data.checked
      row.summary={id:"one",subject:data.rtl?"Re: مرحبا بالعالم":"Title",subjectDirection:data.rtl?"rtl":"ltr",
        from:{display:data.rtl?"محمد":"Sender with a longer display name"},snippet:"Description",time:"09:14",unread:true,starred:false,
        sourceLabel:data.source,thread:data.conversation?{id:"thread",memberIds:["one","two"],count:2,total:2}:null}
      waitForRendering(row)
      var sender=findChild(row,"message-sender")
      var time=findChild(row,"message-time")
      var subject=findChild(row,"message-subject")
      var description=findChild(row,"message-description")
      var senderPoint=sender.mapToItem(row,0,0)
      var timePoint=time.mapToItem(row,0,0)
      var subjectPoint=subject.mapToItem(row,0,0)
      var descriptionPoint=description.mapToItem(row,0,0)
      compare(Math.round(senderPoint.y+sender.baselineOffset),Math.round(timePoint.y+time.baselineOffset))
      verify(subjectPoint.y>=senderPoint.y+sender.height,"title occupies the second line")
      verify(descriptionPoint.y>=subjectPoint.y+subject.height,"description occupies the third line")
      compare(Math.round(timePoint.x+time.width),Math.round(subjectPoint.x+subject.width),"time aligns with the text area's right edge")
      verify(sender.width>0)
      verify(senderPoint.x+sender.width<=timePoint.x)
      compare(subject.font.bold,true,"unread emphasis survives reordering")
      compare(subject.textFormat,Text.PlainText)
      compare(subject.effectiveHorizontalAlignment,data.rtl?Text.AlignRight:Text.AlignLeft)
      compare(findChild(row,"message-source").visible,data.source!=="")
      compare(findChild(row,"message-conversation-count").visible,data.conversation)
      if(data.source!=="")verify(findChild(row,"message-source").width<=row.width/3)
    }
  }
}
