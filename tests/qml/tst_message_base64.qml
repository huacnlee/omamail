import QtQuick 2.15
import QtTest 1.3
import "../../message/Message.js" as Message

Item {
  TestCase {
    name: "MessageBase64"

    function test_qt_atob_result_is_not_decoded_a_second_time() {
      compare(Message.decodeBase64Url("QWxleCDDoCBsJ8OpY29sZQ=="), "Alex à l'école")
    }
  }
}
