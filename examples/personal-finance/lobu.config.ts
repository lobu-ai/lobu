import {
  defineAgent,
  defineConfig,
  defineSkill,
  defineEntityType,
  defineRelationshipType,
  defineAutomation,
  every,
  secret,
  field,
  Type,
} from "@lobu/cli/config";

const gmailTxSkill = defineSkill({
  name: "gmail-tx",
  content:
    'You are a private financial accountant scanning the user\'s forwarded Gmail messages for events that matter to a UK Self Assessment return.\n\nThe emails to scan arrive in the payload\'s `gmail_messages` source (an empty source means no new messages this window). The active tax year, when one is bound, appears in the payload\'s `entities` array.\n\nIdentify and extract financial events. Each email may yield zero, one, or many events. Be conservative: skip noise (marketing, password resets, etc.).\n\nCategories to extract:\n- **transactions** — deposits, debits, transfers, salary credits, dividend payments hitting an account\n- **cgt_events** — broker contract notes for sells/disposals, gifts, transfers out of a GIA\n- **dividends** — UK or foreign dividend notifications (gross + currency)\n- **documents** — P60/P45/P11D/SA302/contract notes/mortgage statements arriving as attachments or linked PDFs\n\nFor each item, set `gmail_message_id` to the `id` value of the `gmail_messages` row it came from — that column is the provider message ID. Never invent or omit it; if you cannot attribute an item to a specific row, drop the item. Prefer GBP unless the message clearly states a different currency.\n\nSkip transactions inside ISAs and SIPPs unless they are dividends or contributions (which are still reportable). Mark `tax_relevance="none"` for ISA-internal transactions; mark `tax_relevance="cgt"` for non-wrapper disposals.\n',
});

const personal_finance = defineAgent({
  id: "personal-finance",
  skills: [gmailTxSkill],
  dir: ".",
  name: "personal-finance",
  description:
    "Help individuals capture wages, expenses, savings, dividends, capital gains and pension contributions across the tax year and assemble a UK Self Assessment (SA100) return.",
  providers: [
    {
      id: "claude",
      model: "claude-sonnet-5",
      key: secret("ANTHROPIC_API_KEY"),
    },
  ],
  network: {
    allowed: [
      ".gov.uk",
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "registry.npmjs.org",
      ".npmjs.org",
    ],
  },
  nixPackages: ["poppler_utils", "csvtk"],
});

const account = defineEntityType({
  key: "account",
  name: "Account",
  description:
    "A bank, savings, brokerage, pension, mortgage, or business account. Owner is always set via the owned_by relationship (or co_owned_by for joint accounts) — never inferred from context.",
  properties: {
    provider: field("Provider", {
      description: 'Bank or broker name (e.g. "Monzo", "Hargreaves Lansdown")',
    }),
    wrapper: field("Wrapper", {
      enum: [
        "current",
        "savings",
        "business_current",
        "business_savings",
        "ISA",
        "LISA",
        "JISA",
        "SIPP",
        "workplace_pension",
        "GIA",
        "mortgage",
        "credit_card",
        "loan",
        "other",
      ],
      description:
        "Account class. Drives tax treatment (ISA = no SA reporting, GIA = CGT applies, etc.).",
    }),
    currency: field("Ccy", {
      description: "ISO 4217 currency code",
      default: "GBP",
      optional: true,
    }),
    account_number_last4: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Last 4 digits, for matching against statements",
      })
    ),
    sort_code: Type.Optional(Type.Unsafe({ type: "string" })),
    iban: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "For non-UK accounts; preferred over sort_code+account_number when known",
      })
    ),
    opening_balance: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: 'Decimal string, e.g. "1234.56"',
      })
    ),
    closing_balance: Type.Optional(Type.Unsafe({ type: "string" })),
    notes: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const allowance_window = defineEntityType({
  key: "allowance_window",
  name: "Allowance Window",
  description:
    'A materialized accumulator for one tax allowance over one tax year. Lets the agent answer "how much ISA budget left this year?" or "how much pension annual allowance can I still use?" instantly without recomputing across all underlying transactions/contributions every time.',
  properties: {
    kind: field("Allowance", {
      enum: [
        "isa_subscription",
        "dividend_allowance",
        "personal_savings_allowance",
        "cgt_annual_exempt",
        "pension_annual_allowance",
        "property_income_allowance",
        "trading_allowance",
        "personal_allowance",
      ],
      description: "Which HMRC-defined allowance this window tracks",
    }),
    cap: field("Cap", {
      description:
        'Decimal GBP. The statutory limit for this allowance in this year (e.g. "20000" for ISA, "60000" for pension AA).',
    }),
    used: field("Used", {
      description:
        "Decimal GBP consumed so far. Updated on every relevant transaction/contribution write.",
    }),
    remaining: field("Remaining", {
      description:
        "Decimal GBP. cap minus used minus carry_forward used. May go negative if a tapered allowance applies (the agent surfaces this).",
      optional: true,
    }),
    carry_forward_in: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "For pension AA — unused allowance carried in from the prior 3 years.",
      })
    ),
    carry_forward_out: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Unused this year, available to carry forward (subject to the allowance's rules).",
      })
    ),
    last_recomputed_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description:
          "When the agent last recomputed used/remaining from underlying entities.",
      })
    ),
  },
});

const asset_lot = defineEntityType({
  key: "asset_lot",
  name: "Asset Lot",
  description:
    "An acquisition lot used for s.104 share-pool / matching rules. One lot per buy event.",
  properties: {
    pool_id: field("Pool", {
      description: "Identifier for the s.104 pool (typically the ticker/ISIN)",
      optional: true,
    }),
    acquisition_date: field("Acquired", { format: "date" }),
    quantity: field("Quantity"),
    cost_basis: field("Cost", {
      description: "Total cost for this lot, decimal GBP",
    }),
    quantity_remaining: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "After partial disposals",
      })
    ),
  },
});

const cgt_event = defineEntityType({
  key: "cgt_event",
  name: "CGT Event",
  description:
    "A capital-gains disposal — sale, gift, or other event triggering CGT (SA108).",
  properties: {
    asset_description: field("Asset"),
    asset_class: field("Class", {
      enum: [
        "listed_shares",
        "unlisted_shares",
        "residential_property",
        "other_property",
        "crypto",
        "other",
      ],
    }),
    acquisition_date: Type.Optional(
      Type.Unsafe({ type: "string", format: "date" })
    ),
    acquisition_cost: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Total acquisition cost, decimal string GBP",
      })
    ),
    disposal_date: field("Disposal", { format: "date" }),
    disposal_proceeds: field("Proceeds", {
      description: "Total proceeds, decimal string GBP",
    }),
    incidental_costs: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Legal, broker, SDLT on acquisition, enhancement",
      })
    ),
    relief_claimed: field("Relief", {
      enum: [
        "none",
        "PRR",
        "BADR",
        "investors_relief",
        "gift_holdover",
        "EIS_deferral",
        "SEIS_deferral",
      ],
      default: "none",
      optional: true,
    }),
    residential_60day_return_ref: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "HMRC reference if a 60-day residential CGT return was already filed",
      })
    ),
  },
});

const company = defineEntityType({
  key: "company",
  name: "Company",
  description:
    "A legal entity that can hold accounts, file tax returns, employ people, or be owned. Covers Ltd, PLC, LLP, sole-trader, partnership, trust, and charity. Discriminate by company_type.",
  properties: {
    legal_name: field("Name"),
    company_type: field("Type", {
      enum: [
        "ltd",
        "plc",
        "llp",
        "sole_trader",
        "partnership",
        "trust",
        "charity",
        "foreign",
      ],
    }),
    incorporation_date: Type.Optional(
      Type.Unsafe({ type: "string", format: "date" })
    ),
    registered_address: Type.Optional(Type.Unsafe({ type: "string" })),
    accounting_period_start: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date",
        description:
          "Start of the company's accounting reference period (CT600 / SA800 anchor)",
      })
    ),
    accounting_period_end: Type.Optional(
      Type.Unsafe({ type: "string", format: "date" })
    ),
    vat_registered: Type.Optional(
      field(Type.Boolean({ default: false }), "VAT")
    ),
    vat_scheme: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: [
          "standard",
          "flat_rate",
          "cash_accounting",
          "annual_accounting",
          "none",
        ],
        default: "none",
      })
    ),
    is_personal_service_company: Type.Optional(
      Type.Unsafe({
        type: "boolean",
        default: false,
        description:
          "Marks PSCs (relevant for IR35 / off-payroll-working rules)",
      })
    ),
    dormant_flag: Type.Optional(
      Type.Unsafe({ type: "boolean", default: false })
    ),
    ceased_date: Type.Optional(Type.Unsafe({ type: "string", format: "date" })),
    notes: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const contribution = defineEntityType({
  key: "contribution",
  name: "Contribution",
  description:
    "A pension or charitable contribution affecting tax (Gift Aid, SIPP, etc.).",
  properties: {
    scheme: field("Scheme", { description: "Provider/charity name" }),
    mechanism: field("Mechanism", {
      enum: ["relief_at_source", "net_pay", "salary_sacrifice", "gift_aid"],
      description:
        "Pension relief mechanism, or gift_aid for charitable donations",
    }),
    amount: field("Amount", { description: "Net amount paid, decimal GBP" }),
    date: field("Date", { format: "date" }),
    carry_back_to_prior_year: Type.Optional(
      Type.Unsafe({
        type: "boolean",
        default: false,
        description: "Gift Aid carry-back election",
      })
    ),
  },
});

const document = defineEntityType({
  key: "document",
  name: "Document",
  description:
    "A source document — P60, P45, P11D, SA302, broker contract note, mortgage statement, bank statement — that other entities are parsed from.",
  properties: {
    doc_type: field("Type", {
      enum: [
        "P60",
        "P45",
        "P11D",
        "SA302",
        "bank_statement",
        "savings_statement",
        "broker_statement",
        "contract_note",
        "dividend_voucher",
        "mortgage_statement",
        "rental_agreement",
        "receipt",
        "other",
      ],
    }),
    source: field("Source", { enum: ["gmail", "whatsapp_upload", "manual"] }),
    download_url: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "uri",
        description: "Signed gateway artifact URL",
      })
    ),
    payer_or_employer: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Counterparty named on the document",
      })
    ),
    captured_at: Type.Optional(
      Type.Unsafe({ type: "string", format: "date-time" })
    ),
  },
});

const expense = defineEntityType({
  key: "expense",
  name: "Expense",
  description: "An allowable expense against a trade or property.",
  properties: {
    category: field("Category", {
      enum: [
        "cost_of_goods",
        "travel",
        "premises",
        "repairs",
        "admin",
        "advertising",
        "interest_finance",
        "professional_fees",
        "wages",
        "utilities",
        "insurance",
        "agent_fees",
        "other",
      ],
    }),
    amount: field("Amount", { description: "Decimal GBP" }),
    date: field("Date", { format: "date" }),
    notes: Type.Optional(Type.Unsafe({ type: "string" })),
    is_capital: Type.Optional(
      Type.Unsafe({
        type: "boolean",
        default: false,
        description:
          "Capital vs revenue (capital expenses go to capital_allowances, not expenses)",
      })
    ),
  },
});

const filing_obligation = defineEntityType({
  key: "filing_obligation",
  name: "Filing Obligation",
  description:
    "A required tax return or filing the user (or one of their companies) must submit by a deadline. Captures SA100, CT600, SA800, SA900, VAT101, P11D, etc. Lets the agent surface deadlines proactively and reconcile against actual filings.",
  properties: {
    return_form: field("Form", {
      enum: [
        "SA100",
        "SA800",
        "SA900",
        "CT600",
        "VAT101",
        "P11D",
        "PAYE_RTI",
        "confirmation_statement",
      ],
    }),
    period_start: { type: "string", format: "date" },
    period_end: { type: "string", format: "date" },
    deadline_type: field("Deadline", {
      enum: [
        "paper_filing",
        "online_filing",
        "balancing_payment",
        "poa1",
        "poa2",
        "corp_tax_payment",
        "corp_tax_filing",
        "vat_payment",
        "registration",
      ],
    }),
    due_date: field("Due", { format: "date" }),
    status: field("Status", {
      enum: ["upcoming", "reminded", "overdue", "filed", "paid", "waived"],
      default: "upcoming",
      optional: true,
    }),
    completed_date: Type.Optional(
      Type.Unsafe({ type: "string", format: "date" })
    ),
    hmrc_reference: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "HMRC submission receipt or reference number, once filed.",
      })
    ),
  },
});

const goal = defineEntityType({
  key: "goal",
  name: "Goal",
  description:
    "A personal financial goal (emergency fund, deposit, retirement target, etc.).",
  properties: {
    name: field("Goal"),
    target_amount: field("Target", { description: "Decimal GBP" }),
    target_date: field("By", { format: "date", optional: true }),
    category: field("Category", {
      enum: ["emergency_fund", "deposit", "retirement", "debt_payoff", "other"],
    }),
    current_amount: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Optional snapshot, decimal GBP",
      })
    ),
  },
});

const holding = defineEntityType({
  key: "holding",
  name: "Holding",
  description: "A current security position in a brokerage account.",
  properties: {
    ticker: field("Ticker"),
    isin: Type.Optional(Type.Unsafe({ type: "string" })),
    quantity: field("Quantity", { description: "Decimal string" }),
    avg_cost: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Average cost per unit (s.104 pool), decimal string",
      })
    ),
    currency: Type.Optional(Type.Unsafe({ type: "string", default: "GBP" })),
    as_of_date: field("As of", { format: "date" }),
  },
});

const income_source = defineEntityType({
  key: "income_source",
  name: "Income Source",
  description:
    "A recurring origin of income (employer, trade, dividend payer, interest payer, rental property, pension, foreign source).",
  properties: {
    type: field("Type", {
      enum: [
        "employment",
        "self_employment",
        "dividend",
        "interest",
        "rental",
        "pension",
        "foreign",
      ],
    }),
    payer_name: field("Payer", { optional: true }),
    country: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "ISO 3166-1 alpha-2; non-GB triggers SA106",
      })
    ),
    foreign_tax_paid: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Decimal — total foreign tax withheld at source for the tax year, in foreign_tax_currency. Drives Foreign Tax Credit Relief (FTCR) on SA106.",
      })
    ),
    foreign_tax_currency: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "ISO 4217 of the foreign_tax_paid amount. Usually matches the income currency.",
      })
    ),
    withholding_jurisdiction: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "ISO 3166-1 alpha-2 of the country that withheld the tax. May differ from `country` (e.g. US dividends paid via a UK broker — withheld in US, paid to UK).",
      })
    ),
    treaty_rate_applied: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          'Decimal — treaty withholding rate already applied at source (e.g. "0.15" for the 15% US/UK treaty rate on dividends). Used to flag over-withholding that may be recoverable from the source country.',
      })
    ),
    notes: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const payment = defineEntityType({
  key: "payment",
  name: "Payment",
  description:
    "A payment to or from HMRC — balancing payments, payments on account, corporation tax, VAT remittances, refunds. Distinct from generic transactions because it ties to filing_obligation and tax_assessment for reconciliation.",
  properties: {
    amount: field("Amount", { description: "Decimal — always positive" }),
    currency: { type: "string", default: "GBP" },
    date: field("Date", { format: "date" }),
    direction: field("Direction", { enum: ["to_hmrc", "from_hmrc"] }),
    kind: field("Kind", {
      enum: [
        "balancing_payment",
        "poa1",
        "poa2",
        "corp_tax",
        "vat",
        "paye_nic",
        "refund",
        "penalty",
        "interest",
      ],
    }),
    reference: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "HMRC payment reference (UTR + K, or CT-specific accounting reference)",
      })
    ),
    method: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: [
          "bank_transfer",
          "direct_debit",
          "debit_card",
          "cheque",
          "paye_coding",
        ],
      })
    ),
  },
});

const property = defineEntityType({
  key: "property",
  name: "Property",
  description:
    "Real estate. Use for primary residences (PRR on disposal), let properties (SA105/SA106), holiday lets (FHL), and commercial real estate. Owner is set via owned_by or co_owned_by; never put owner in metadata.",
  properties: {
    address: field("Address"),
    type: field("Type", {
      enum: ["residential", "commercial", "mixed_use", "land"],
    }),
    use: field("Use", {
      description:
        "How the property is used. Drives tax treatment more than physical type does.",
      enum: [
        "primary_residence",
        "let",
        "FHL",
        "commercial_let",
        "mixed_use",
        "investment_held",
      ],
    }),
    country: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "ISO 3166-1 alpha-2; non-GB triggers SA106",
        default: "GB",
      })
    ),
    rental_income_allowance_claimed: Type.Optional(
      Type.Unsafe({
        type: "boolean",
        default: false,
        description: "£1,000 property income allowance flag",
      })
    ),
    purchase_date: Type.Optional(
      Type.Unsafe({ type: "string", format: "date" })
    ),
    purchase_cost: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Decimal GBP — useful for PRR calculation on eventual disposal",
      })
    ),
  },
});

const relief_claim = defineEntityType({
  key: "relief_claim",
  name: "Relief Claim",
  description:
    "A tax relief or allowance claim (Gift Aid, marriage allowance, EIS/SEIS, BADR, PRR).",
  properties: {
    type: field("Type", {
      enum: [
        "gift_aid",
        "marriage_allowance",
        "EIS",
        "SEIS",
        "BADR",
        "PRR",
        "investors_relief",
        "foreign_tax_credit",
      ],
    }),
    amount: field("Amount", {
      description: "Decimal GBP if applicable",
      optional: true,
    }),
    notes: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const tax_assessment = defineEntityType({
  key: "tax_assessment",
  name: "Tax Assessment",
  description:
    "A computed or HMRC-issued tax position for one tax year, one subject. Captures SA302 outputs (HMRC's view) + agent-computed projections (our view) so we can reconcile and surface differences.",
  properties: {
    source: field("Source", {
      enum: [
        "agent_projection",
        "hmrc_sa302",
        "hmrc_ct600_acknowledgement",
        "manual",
      ],
      description:
        "Where this assessment came from. agent_projection = our running estimate; hmrc_* = the authority's number.",
    }),
    total_income: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Decimal GBP — sum of all income sources before allowances",
      })
    ),
    total_tax_due: field("Tax due", {
      description: "Decimal GBP — final tax liability for the year",
    }),
    tax_paid_at_source: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "PAYE + dividend tax withheld + foreign tax credit",
      })
    ),
    balancing_owed: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "total_tax_due - tax_paid_at_source - poa_paid",
      })
    ),
    allowances_used: Type.Optional(
      Type.Unsafe({
        type: "object",
        description:
          "Per-allowance breakdown (personal_allowance, dividend_allowance, psa, cgt_aea, etc.)",
      })
    ),
    computed_at: { type: "string", format: "date-time" },
    hmrc_reference: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

const tax_year = defineEntityType({
  key: "tax_year",
  name: "Tax Year",
  description:
    "A UK fiscal year (6 April to 5 April) — the container all reportable activity is anchored to.",
  properties: {
    year_label: field("Year", { description: 'Year label, e.g. "2025-26"' }),
    start: {
      type: "string",
      format: "date",
      description: "Inclusive start, e.g. 2025-04-06",
    },
    end: {
      type: "string",
      format: "date",
      description: "Inclusive end, e.g. 2026-04-05",
    },
    filing_status: field("Status", {
      enum: ["in_progress", "assembled", "filed"],
      description: "Where the user is in the cycle",
      optional: true,
    }),
    filed_at: Type.Optional(
      Type.Unsafe({ type: "string", format: "date-time" })
    ),
    residence_status: field("Residence", {
      enum: [
        "uk_resident",
        "non_resident",
        "split_year_arriver",
        "split_year_leaver",
        "dual_resident",
      ],
      description:
        "UK tax residence for THIS year. Recorded per-tax_year because residence\ncan change (someone moving in/out of the UK has different status year\nto year). Drives SA109 routing.\n",
      optional: true,
    }),
    arrival_date: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date",
        description: "For split-year arrivers — date residence began",
      })
    ),
    departure_date: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date",
        description: "For split-year leavers — date residence ended",
      })
    ),
  },
});

const transaction = defineEntityType({
  key: "transaction",
  name: "Transaction",
  description: "A single debit or credit on an account.",
  properties: {
    date: field("Date", { format: "date" }),
    amount: field("Amount", {
      description: "Decimal string. Positive = credit, negative = debit.",
    }),
    currency: { type: "string", default: "GBP" },
    description: field("Description", { optional: true }),
    merchant_raw: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Verbatim merchant text from the statement; resolved/categorised later.",
      })
    ),
    tax_relevance: field("Tax", {
      enum: ["none", "income", "expense", "cgt"],
      description: "Whether this transaction matters for the SA return.",
      optional: true,
    }),
    expense_category: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "HMRC-aligned category for allowable expenses (cost_of_goods, travel, premises, repairs, admin, advertising, interest, professional_fees, wages, other).",
      })
    ),
    is_personal: Type.Optional(Type.Unsafe({ type: "boolean", default: true })),
    native_amount: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Decimal amount in the foreign currency, when currency != GBP. Keep alongside `amount` so the agent can show both numbers and recompute if rates need correcting.",
      })
    ),
    native_currency: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          'ISO 4217 currency code of native_amount (e.g. "USD", "EUR"). When set, the `currency` field on this transaction is GBP and native_currency is the original.',
      })
    ),
    fx_rate_to_gbp: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Decimal — the FX rate snapshot used to convert native_amount to amount (GBP). Source the rate from the transaction date. Required when native_currency is set so HMRC-aligned conversion is auditable.",
      })
    ),
    fx_rate_source: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          'Where the FX rate came from (e.g. "hmrc_monthly", "broker_statement", "ecb_daily"). Helps reconcile if HMRC\'s published rate differs.',
      })
    ),
  },
});

const account_contains = defineRelationshipType({
  key: "account_contains",
  name: "Account Contains",
  description: "An account contains a transaction or holding.",
});

const accountant_for = defineRelationshipType({
  key: "accountant_for",
  name: "Accountant For",
  description:
    "One subject acts as accountant or agent for another. Lets a hired accountant Lobu user be granted access to a client's $member or company entity later. Source can be either $member or company; target can be either.",
});

const accumulates_in = defineRelationshipType({
  key: "accumulates_in",
  name: "Accumulates In",
  description:
    "A transaction or contribution counts toward an allowance window. E.g. an ISA deposit accumulates_in the year's isa_subscription window; a pension contribution accumulates_in the year's pension_annual_allowance window.",
});

const assessment_for = defineRelationshipType({
  key: "assessment_for",
  name: "Assessment For",
  description:
    "A tax_assessment is for a particular tax_year and subject. Used to anchor agent projections and HMRC SA302 outputs to the same year + filer so they can be compared.",
});

const co_owned_by = defineRelationshipType({
  key: "co_owned_by",
  name: "Co-owned By",
  description:
    "An asset is jointly owned by multiple subjects. One row per co-owner. Sum of share_pct across all co-owners should equal 100.",
});

const controls = defineRelationshipType({
  key: "controls",
  name: "Controls",
  description:
    "A person or company exercises significant control over a company (PSC register entry under the Companies Act). Source can be $member or company.",
});

const director_of = defineRelationshipType({
  key: "director_of",
  name: "Director Of",
  description: "A person is a registered director of a company.",
});

const disposal_of = defineRelationshipType({
  key: "disposal_of",
  name: "Disposal Of",
  description: "A CGT event disposes of (all or part of) an asset lot.",
});

const employed_by = defineRelationshipType({
  key: "employed_by",
  name: "Employed By",
  description:
    "An employment-type income source flows from a particular employer (a company entity). Pairs with employee_of when the agent has the direct subject-to-subject employment fact.",
});

const employee_of = defineRelationshipType({
  key: "employee_of",
  name: "Employee Of",
  description:
    "A person is employed by a company. Replaces the older `employed_by` indirection through `income_source` for direct subject-to-subject employment facts.",
});

const expense_of = defineRelationshipType({
  key: "expense_of",
  name: "Expense Of",
  description:
    "An expense is incurred against a subject — a $member (personal allowable expense), a property (SA105/SA106), or a company (operating cost on the business books).",
});

const for_tax_year = defineRelationshipType({
  key: "for_tax_year",
  name: "For Tax Year",
  description:
    "An entity (transaction, cgt_event, contribution, relief_claim, expense) is recorded against a particular tax year.",
});

const income_from = defineRelationshipType({
  key: "income_from",
  name: "Income From",
  description:
    "A transaction is income from a particular source (employer, dividend payer, interest payer, rental, etc.).",
});

const obligation_for = defineRelationshipType({
  key: "obligation_for",
  name: "Obligation For",
  description:
    'A filing_obligation belongs to a tax_year and a subject ($member or company). The same SA100 obligation is "for" the user\'s $member and "for" their tax_year.',
});

const owned_by = defineRelationshipType({
  key: "owned_by",
  name: "Owned By",
  description:
    "An asset (account, holding, asset_lot, property) is owned by a subject ($member or company). Use co_owned_by instead when ownership is shared.",
});

const parsed_from = defineRelationshipType({
  key: "parsed_from",
  name: "Parsed From",
  description:
    "An entity (transaction, cgt_event, holding, etc.) was parsed from a source document — provenance link.",
});

const partner_in = defineRelationshipType({
  key: "partner_in",
  name: "Partner In",
  description:
    "A person is a partner in an LLP or partnership. Drives SA104 routing for partnership income.",
});

const settles = defineRelationshipType({
  key: "settles",
  name: "Settles",
  description:
    "A payment settles part or all of a filing_obligation (e.g. balancing_payment settles SA100 balancing). One filing_obligation may be settled by multiple payments.",
});

const shareholder_of = defineRelationshipType({
  key: "shareholder_of",
  name: "Shareholder Of",
  description:
    "A person or company holds shares in a company. Source can be either $member or company (companies can own other companies).",
});

const spouse_of = defineRelationshipType({
  key: "spouse_of",
  name: "Spouse Of",
  description:
    "Marriage or civil partnership. Symmetric. Relevant for marriage allowance, jointly held assets, and inheritance planning.",
});

const transfer_pair = defineRelationshipType({
  key: "transfer_pair",
  name: "Transfer Pair",
  description:
    "Two transactions are the two legs of an internal transfer between accounts the same subject controls (e.g. Jane's current → Jane's savings). Salary or distributions crossing subject boundaries (Ltd current → Jane personal) are NOT internal transfers and must not be linked here. Symmetric. When this link exists, neither side counts as taxable income or as an allowable expense.",
});

const gmailTxAutomation = defineAutomation({
  agent: personal_finance,
  slug: "gmail-tx",
  name: "Gmail financial-event extractor",
  triggers: [every("*/30 * * * *")],
  minCooldownSeconds: 300,
  tags: ["personal-finance", "gmail", "ingestion"],
  reactionsGuidance:
    'After extracting:\n1. Resolve or create the active `tax_year` entity from the user\'s profile. Each new transaction / cgt_event / contribution must be linked to it via `for_tax_year`.\n2. For each `documents[]` entry, create a `document` entity (source="gmail") and use it as the `parsed_from` target for the transactions / cgt_events / dividends extracted from that same gmail_message_id.\n3. For each `transactions[]` entry, resolve or create the `account` from `account_hint` and link via `account_contains`. If income, create or resolve an `income_source` and link via `income_from`.\n4. For `cgt_events[]`, look up matching `asset_lot` rows in the same `pool_id` and link via `disposal_of`. If acquisition data is missing, save a note flagging the gap rather than guessing.\n5. For `dividends[]`, create a `transaction(tax_relevance=income)` linked to an `income_source(type=dividend, payer_name, country)`.\n6. Never overwrite a user-edited entity. If a duplicate is suspected (same date + amount + account), surface it as a question instead of writing.\n',
  sources: {
    gmail_messages:
      "SELECT id, title, payload_text, payload_html, occurred_at FROM events WHERE connector_key = 'google.gmail' ORDER BY occurred_at DESC LIMIT 200\n",
  },
  skills: ["gmail-tx"],
});

export default defineConfig({
  org: "personal-finance",
  orgName: "Personal Finance",
  orgDescription:
    "UK Self Assessment helper — captures financial activity across the tax year and assembles SA100 + supplementary pages.",
  agents: [personal_finance],
  entities: [
    account,
    allowance_window,
    asset_lot,
    cgt_event,
    company,
    contribution,
    document,
    expense,
    filing_obligation,
    goal,
    holding,
    income_source,
    payment,
    property,
    relief_claim,
    tax_assessment,
    tax_year,
    transaction,
  ],
  relationships: [
    account_contains,
    accountant_for,
    accumulates_in,
    assessment_for,
    co_owned_by,
    controls,
    director_of,
    disposal_of,
    employed_by,
    employee_of,
    expense_of,
    for_tax_year,
    income_from,
    obligation_for,
    owned_by,
    parsed_from,
    partner_in,
    settles,
    shareholder_of,
    spouse_of,
    transfer_pair,
  ],
  automations: [gmailTxAutomation],
});
