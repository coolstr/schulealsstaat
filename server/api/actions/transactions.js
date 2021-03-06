var log = require("../logging.js");
var db = require("../db");
var cert = require("../cert");
var config = require("../config");
var flow = require("flow");
var common = require("./common.js");

// Round a currency value
function HGC_roundup(value) {
	var decplaces = config.get("hgc_decimal_places", 5);
	return Math.ceil(value * Math.pow(10, decplaces)) / Math.pow(10, decplaces);
}

module.exports = function (register, register_cert) {
/**
 * get_balance {
 *	qrid : String(QR-ID),
 *	password : String
 * }
 *
 * respone values:
 * a Number (in String)	--> balance of the person with qrid if password was correct
 * invalid_qrid		--> the provided qrid doesn't exist
 * invalid_password	--> provided password was wrong
 * error:<something>	--> Some other error, e.g. with JSON parsing
 */
register("get_balance", function (payload, answer) {
	db.students.getByQrid(payload.qrid, function (st) {
		if (!st) {
			answer("invalid_qrid");
			return;
		}

		if(!payload.password || !common.check_password(st, payload.password)) {
			answer("invalid_password");
			return;
		}

		answer(String(st.balance));
	});
});

/**
 * get_last_transactions {
 *	qrid : String(QR-ID),
 *	password : String,
 *	amount : Number (returns <amount> last transactions or all transactions if amount <= 0)
 * }
 *
 * respone values:
 * Array		--> transactions of the person with qrid if password was correct
 *			--> Form: [{
 *				sender : String,
 *				recipient : String,
 *				time : Date,
 *				amount_sent : Number,
 *				amount_received : Number,
 *				amount_tax : Number,
 *				percent_tax : Number,
 *				comment : String,
 *				NOT: sender_ip }]
 * invalid_qrid		--> the provided qrid doesn't exist
 * invalid_password	--> provided password was wrong
 * error:<something>	--> Some other error, e.g. with JSON parsing
 */
register("get_last_transactions", function (payload, answer) {
	db.students.getByQrid(payload.qrid, function (st) {
		if (!st) {
			answer("invalid_qrid");
			return;
		}

		if(!common.check_password(st, payload.password)) {
			answer("invalid_password");
			return;
		}

		db.transactions.getByIdList(st.transactions, function (tr) {
			if (payload.amount > 0)
				tr = tr.slice(0, payload.amount);
			answer(tr);
		});
	});
});

/**
 * find_transactions {
 *	query : Query for transactions DB,
 *	amount : Number (returns <amount> last transactions or all transactions if amount <= 0)
 * }
 *
 * response values:
 * Array		--> all matching transactions
 *			--> Form: [{
 *				sender : String,
 *				recipient : String,
 *				time : Date,
 *				amount_sent : Number,
 *				amount_received : Number,
 *				amount_tax : Number,
 *				percent_tax : Number,
 *				comment : String,
 *				sender_ip : String }]
 * Array may also be empty, if no matching transactions were found
 */
register_cert("find_transactions", ["admin_hash"], function (payload, answer) {
	db.transactions.getByProperties(payload.query, function (tr) {
		if (payload.amount > 0)
			tr = tr.slice(0, payload.amount);
		answer(tr);
	});
});

/**
 * On startup: Check if tax income account exists
 */
db.students.getByQrid(config.get("taxinc_qrid", "taxinc"), function (taxinc) {
	if (!taxinc)
		log.err("BANK", "Tax income account not found. You MUST create a tax income" + 
			"account in order to collect any taxes.");
});

/**
 * Net value <--> gross value conversion
 * gross value (brutto) --> amount_sent
 * net value   (netto ) --> amount_received
 *
 * Formulas:
 *   --> taxamount = tax% * net 
 *   --> taxamount = tax% * gross / (1 + tax%)
 *
 * Tax parameter is in % already, so it has to be converted.
 */
function gross2tax(gross, tax_percent) {
	var tax = tax_percent / 100;
	return HGC_roundup(tax * gross / (1 + tax));
}

function net2tax(net, tax_percent) {
	var tax = tax_percent / 100;
	return HGC_roundup(tax * net);
}

/**
 * Perform transaction
 * Takes care of money transfer + logging
 * Does NOT perform any security checks, so there is no need for a password
 * Does NOT sanitize all of user input, like number of decimal places or comment length
 * Calls cb(res), where res is a paremeter indication success ("ok") or errors:
 * "ok", "nomoney", "invalid_sender", "invalid_recipient", "overspecified", "invalid_amount"
 * If the recipient is the magic_account, the money will be destroyed
 * If the sender is the magic_account, the money will be spawned
 */
function transaction(sender_qrid, recipient_qrid, amount_sent, amount_received, tax,
		comment, sender_ip, cb) {
	var sender, recipient, taxinc;
	var magic_account = config.get("magic_account", "Zentralbank");
	var spawn_money = sender_qrid == magic_account;
	var destroy_money = recipient_qrid == magic_account;

	// Check for over- or underspecification (amount_sent / amount_received)
	if (!amount_sent && !amount_received) { cb ("underspecified"); return; }
	if (amount_sent && amount_received) { cb ("overspecified"); return; }

	// Check for invalid money amounts
	if (amount_sent && (!Number.isFinite(amount_sent) || amount_sent <= 0))
		{ cb("invalid_amount"); return; }
	if (amount_received && (!Number.isFinite(amount_received) || amount_received <= 0))
		{ cb("invalid_amount"); return; }

	/*** Load all required database entries ***/
	flow.exec(function () {
		db.students.getByQrid(config.get("taxinc_qrid", "taxinc"), this);
	}, function (st) {
		if (!st) { cb("error: no tax income account"); return; }
		taxinc = st;
		if (spawn_money) this(true);
		else db.students.getByQrid(sender_qrid, this);
	}, function (st) {
		if (!st) { cb("invalid_sender"); return; }
		sender = st;
		if (destroy_money) this(true);
		else db.students.getByQrid(recipient_qrid, this);
	}, function (st) {
		if (!st) { cb("invalid_recipient"); return; }
		recipient = st;

		/*** Calculate amount to transfer with taxes ***/
		// In dubio pro central bank - round up after hgc_decimal_places,
		// so central bank gets more tax income and recipient gets less money
		// or sender has to pay more money
		var amount_tax = amount_sent ?
			gross2tax(amount_sent, tax) : net2tax(amount_received, tax);
		amount_sent = amount_sent ? amount_sent : amount_received + amount_tax;
		amount_received = amount_received ? amount_received : amount_sent - amount_tax;

		// Check if sender still has enough money on his account + actual transaction
		if (!spawn_money && sender.balance < amount_sent) { cb("nomoney"); return; }
		if (!spawn_money) sender.balance -= amount_sent;
		recipient.balance += amount_received;
		taxinc.balance += amount_tax;
		taxinc.save();

		/*** Log Transaction in Transactions DB ***/
		db.transactions.add({
			sender : sender_qrid,
			recipient : recipient_qrid,
			time : Date(),
			amount_sent : amount_sent,
			amount_received : amount_received,
			amount_tax : amount_tax,
			percent_tax : tax,
			sender_country : typeof sender == "object" && "country" in sender ?
				sender.country : undefined,
			recipient_country : typeof recipient == "object" && "country" in recipient ?
				recipient.country : undefined,
			sender_ip : sender_ip,
			comment : comment
		}, function (dbtrans) {
			if (!spawn_money) {
				sender.transactions.push(dbtrans._id);
				sender.save();
			}
			if (!destroy_money) {
				recipient.transactions.push(dbtrans._id);
				recipient.save();
			}

			var log_type = "Transaction";
			if (spawn_money) log_type = "spawn_money";
			if (destroy_money) log_type = "destroy_money";
			log.info("BANK", log_type + " from " + sender_qrid + " to " +
				recipient_qrid + ", with net value " + amount_received +
				" HGC, tax income is " + amount_tax + " HGC.");
			});
			cb("ok");
	});
}

/**
 * transaction / transaction_taxfree {
 *	sender : String (QR-ID),
 *	sender_password : String,
 *	recipient : String (QR-ID),
 *	Either provide:
 *	amount_sent : Number, OR amount_received : Number,
 *	comment : String(max. 300 characters)
 * }
 *
 * transaction_taxfree: No tax fees, but requires registration_cert or admin_cert
 *
 * response values:
 * ok			--> Transaction succesfully completed
 * nomoney		--> Sender does not have enough money to pay for the transaction
 * invalid_password	--> Sender password is invalid
 * comment_too_long	--> comment is over 300 chars
 * invalid_sender	--> Sender QR-ID is invalid
 * invalid_recipient	--> Recipient QR-ID is invalid
 * overspecified	--> Both amount_sent and amount_received are specified
 * underspecified	--> Neither amount_sent or amount_received are specified
 * invalid_amount	--> Amount is not > 0
 * too_many_decplaces	--> Amount has more decimal places than hgc_tr_decimal_places allows
 * error:<something>	--> Some other error, e.g. with JSON parsing
 */
function transaction_common(payload, answer, req, tax) {
	/*** Gather data from payload ***/
	var sender = payload.sender;
	var recipient = payload.recipient;
	var sender_password = payload.sender_password;
	var comment = "comment" in payload ? payload.comment : false;
	var sent = "amount_sent" in payload ? payload.amount_sent : false;
	var received = "amount_received" in payload ? payload.amount_received : false;

	/*** Check comment length ***/
	if (comment && comment.length > config.get("tr_comment_maxlen", 300))
		{ answer("comment_too_long"); return; }

	/*** Check if amount has more than hgc_tr_decimal_places decimals ***/
	var tr_decplaces = config.get("hgc_tr_decimal_places", 2);
	if (sent && (sent * Math.pow(10, tr_decplaces)) % 1 !== 0)
		{ answer("too_many_decplaces"); return; }
	if (received && (received * Math.pow(10, tr_decplaces)) % 1 !== 0)
		{ answer("too_many_decplaces"); return; }

	/*** Check sender password + perform transaction ***/
	db.students.getByQrid(sender, function (st) {
		if (!st) { answer("invalid_sender"); return; }
		if (!common.check_password(st, sender_password))
			{ answer("invalid_password"); return; }
		var ip = req.connection.remoteAddress;
		transaction(sender, recipient, sent, received, tax, comment, ip, answer);
	});
}

register("transaction", function (payload, answer, req) {
	// Tax in %
	var tax = config.get("transaction_tax_percent", 10);
	transaction_common(payload, answer, req, tax);
});

register_cert("transaction_taxfree", ["registration_hash", "admin_hash"],
		function (payload, answer, req) {
	transaction_common(payload, answer, req, 0);
});

/**
 * master_hash --> spawn_money {
 *	amount : Number,
 *	recipient : String(QR-ID),
 *	comment : String
 * }
 * response values: "ok" or "error: <something>"
 */
register_cert("spawn_money", ["master_hash"], function (payload, answer, req) {
	var sender = config.get("magic_account", "Zentralbank");
	var recipient = payload.recipient;
	var amount = payload.amount;
	var comment = "spawn_money" + (("comment" in payload) ? " - " + payload.comment : "");
	var ip = req.connection.remoteAddress;

	transaction(sender, recipient, amount, false, 0, comment, ip, answer);
});

/**
 * master_hash --> destroy_money {
 *	amount : Number,
 *	sender : String(QR-ID),
 *	comment : String
 * }
 * response values: "ok" or "error: <something>"
 */
register_cert("destroy_money", ["master_hash"], function (payload, answer, req) {
	var recipient = config.get("magic_account", "Zentralbank");
	var sender = payload.sender;
	var amount = payload.amount;
	var comment = "destroy_money" + (("comment" in payload) ? " - " + payload.comment : "");
	var ip = req.connection.remoteAddress;

	transaction(sender, recipient, amount, false, 0, comment, ip, answer);
});

/**
 * master_hash --> master_transaction {
 *	same arguments as "transaction" action, but:
 *		- doesn't require sender_password
 *		- if "tax_percent" is specified, uses that tax value
 * }
 *
 * Same answers as "transaction" action, apart from too_many_decplaces, comment_too_long
 * (these properties won't be checked)
 */
register_cert("master_transaction", ["master_hash"], function (payload, answer, req) {
	// Tax in %
	var tax_percent = "tax_percent" in payload ?
		payload.tax_percent : config.get("transaction_tax_percent", 10);
	if (tax_percent < 0) { answer("error: invalid tax_percent"); return; }
	var sender = payload.sender;
	var recipient = payload.recipient;
	var sent = "amount_sent" in payload ? payload.amount_sent : false;
	var received = "amount_received" in payload ? payload.amount_received : false;
	var comment = "comment" in payload ? payload.comment : false;
	var ip = req.connection.remoteAddress;

	// Do NOT perform password checking, comment length checking, decimal places checking
	// for master transactions
	transaction(sender, recipient, sent, received, tax_percent, comment, ip, answer);
});

}; // module.exports
