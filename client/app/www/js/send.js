var COMMENT_MAXLEN = 300;
var HGC_TR_DECIMAL_PLACES = 2;

// Will be set to QR-ID values when student_identify is called for the relevant section
var sender = storage.get("qrid");
var password = storage.get("password");
var current_recipient = null;
var amount = null;
var comment = null;

$(function() {
	$("#confirm").click(function () {
		var recipient_qrid = $("#qrid_rec").val();
		var recipient_firstname = $("#firstname").val();
		var recipient_lastname = $("#lastname").val();
		var recipient_type = $("#type").val();
		comment = $("#comment").val();
		amount = parseFloat($("#amount").val());

		var data = {};
		if (recipient_firstname !== "") data.firstname = recipient_firstname;
		if (recipient_lastname !== "") data.lastname = recipient_lastname;
		if (recipient_type !== "") data.type = recipient_type;
		if (recipient_qrid !== "") data.qrid = recipient_qrid;

		action("student_identify", data, function (res) {
			if (res == "multiple") {
				showError("Die Eingabe ist nicht eindeutig:" +
					"Es gibt mehrere Personen, die auf die Kriterien passen.");
				return;
			}

			if (typeof res != "object") {
				showError("Konnte Person nicht finden:" +
					"Die angegebenen Kriterien passen auf keine Person.");
				return;
			}

			if (amount === "" || !amount || isNaN(amount) || amount <= 0) {
				showError("Der angegebene Betrag ist ungültig.");
				return;
			}
			current_recipient = res;

			$("#confirm_recipient").text(student2readable(current_recipient));
			$("#confirm_amount").text(amount);
			$("#confirm_comment").text(comment);
			$("#confirm_back").click(function () {
				$("#confirm_window").fadeOut();
			});
			$("#confirm_window").fadeIn();
		});
	});

	$("#confirm_submit").click(function() {
		var data = {
			amount_sent : amount,
			sender : sender,
			recipient : current_recipient.qrid,
			comment : comment,
			sender_password : password
		};

		action("transaction", data, function (res) {
			if (res == "nomoney") {
				showError("Nicht genug Geld auf dem Senderkonto!");
				return;
			}

			if (res == "invalid_password") {
				showError("Das Sender-Passwort ist falsch!");
				return;
			}

			if (res != "ok") {
				showError("Unbekannter Fehler: " + res);
				return;
			}

			update_balance();
			$("#confirm_window").hide();
			$("#success").show();
		});
	});
});

