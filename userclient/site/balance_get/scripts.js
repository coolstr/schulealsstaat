var current_qrid = undefined;

handleIdentifyAnswer = function(sectionref, st) {
	current_qrid = st.qrid;
}

$(function () {
	$("#header").load("../header.html", function () {
		$("#balance_link").addClass("link-selected");
	});

	$("#balance_box_ok").click(function () {
		$("#balance_box").fadeOut();
		resetAll();
	});

	$(".confirm").click(function () {
		// Check for client errors
		if (!current_qrid) {
			errorMessage("Keine Person angegeben. Wessen Guthaben soll"
				+ " abgefragt werden?");
			return;
		}

		var password = $(".password").val();

		var data = {
			qrid : current_qrid,
			password : password
		};

		// Ask server for balance
		action("get_balance", JSON.stringify(data), function (res) {
			// Check for server errors
			if (res == "invalid_password") {
				errorMessage("Das Passwort ist falsch.");
				return;
			}

			var balance = parseFloat(res);
			if (res.indexOf("error") > -1 || isNaN(res)) {
				errorMessage("Unbekannter Fehler: " + res + "<br/>"
					+ "Bitte melde diesen Fehler bei der Zentralbank.");
				return;
			}

			// Write answer to balance messagebox
			$("#balance_box_value").html(balance.toFixed(5));
			$("#balance_box").fadeIn();
		});
	});
});
