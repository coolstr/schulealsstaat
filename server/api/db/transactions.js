var mongoose = require("mongoose");
var Schema = mongoose.Schema;
var log = require("../logging.js");

var commonProfileSchema = {
	reference :	{ type : Schema.Types.ObjectId, index : true },

	special_name :	{ type : String, index : true },
	firstname :	{ type : String, index : true },
	lastname :	{ type : String, index : true },
	country :	{ type : String, index : true },
	type :		{ type : String, index : true },
	qrid :		{ type : String, index : true }
};

var transactionSchema = new Schema({
	/**
	 * References to sender + recipient and copies of their profiles at transaction time
	 * If either one of them changes e.g. their country, taxes can still be calculated.
	 * Also, if the QR card is reused or if the recipient changes their name, it can be
	 * tracked back in case of fraud or abuse.
	 *
	 * Current information on sender / recipient can be accessed by tracing back their
	 * document _id value (if available in sender.reference, recipient.reference)
	 */
	sender : commonProfileSchema,
	recipient : commonProfileSchema,
	tax_recipient : Schema.Types.ObjectId,

	/* Timestamp */
	time : { type : Date, index : true },

	/* Amount in HGC, rounded to 5 comma values (e.g. 12.34567) */
	amount_sent : Number,		// Amount subtracted from sender's account
	amount_received : Number,	// Amount added to recipient's account
	amount_tax : Number,		// Amount added to tax income account
	percent_tax : Number,		// Stores tax percentage value at transaction time

	/* Tax income account at the time of the transaction */
	recipient_tax : Schema.Types.ObjectId,

	/* Comment is an arbitrary String, up to <tr_comment_maxlen> (in config) characters,
		can be entered by sender or is generated programmatically */
	comment : String
}, { bufferCommands : false });

var Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = function (error) { return {
	add : function (info, answer, cb) {
		var nt = new Transaction(info);
		nt.save(function (err) {
			if (err) {
				error("trdb.add", answer, err);
			} else {
				cb();
			}
		});
	},

	getById : function (id, answer, cb) {
		Transaction.findOne({_id : mongoose.Types.ObjectId(id)}, function (err, tr) {
			if (err) {
				error("trdb.getById", answer, err);
			} else {
				cb(tr);
			}
		});
	},

	getByProperties : function (properties, limit, answer, cb) {
		if (!limit || limit < 0) {
			Transaction.find(properties).sort({
				"time" : "descending"
			}).lean().exec(function (err, tr) {
				if (err) {
					error("trdb.getByProperties (1)", answer, err);
				} else {
					cb(tr);
				}
			});
		} else {
			Transaction.find(properties).sort({
				"time" : "descending"
			}).limit(limit).lean().exec(function (err, tr) {
				if (err) {
					error("trdb.getByProperties (2)", answer, err);
				} else {
					cb(tr);
				}
			});
		}
	},

	getBalance : function (id, answer, cb) {
		// Aggregate income
		Transaction.aggregate([
			{ $match : { "recipient.reference" : id }},
			{ $group : {
				_id : null,
				income : { $sum : "$amount_received" }
			}}
		], function (err, aggr_i) {
			if (err) {
				error("trdb.getBalance (1)", answer, err);
				return;
			}

			var income = aggr_i[0] ? aggr_i[0].income : 0;

			// Aggregate payments
			Transaction.aggregate([
				{ $match : { "sender.reference" : id }},
				{ $group : {
					_id : null,
					payments : { $sum : "$amount_sent" }
				}},
			], function (err, aggr_p) {
				if (err) {
					error("trdb.getBalance (2)", answer, err);
					return;
				}
				var payments = aggr_p[0] ? aggr_p[0].payments : 0;

				// Aggregate tax income (this may be a tax income account)
				Transaction.aggregate([
					{ $match : { "tax_recipient" : id }},
					{ $group : {
						_id : null,
						taxincome : { $sum : "$amount_tax" }
					}},
				], function (err, aggr_ti) {
					if (err) {
						error("trdb.getBalance (3)", answer, err);
						return;
					}
					var taxincome = aggr_ti[0] ? aggr_ti[0].taxincome : 0;
					cb(income + taxincome - payments);
				});
			});
		});
	}
}};
