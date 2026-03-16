const getStats = (req, res) => {
  // Dummy data for now – good enough to build the UI
  res.json({
    success: true,
    data: {
      calls_made: 1247,
      conversion_rate: 12.5,
      revenue: 45800,
      meetings: 89,
      active_campaigns: 3,
    },
  });
};

const getRecentCalls = (req, res) => {
  const calls = [
    {
      id: 1,
      lead_id: 101,
      campaign_id: 1,
      name: "Sunrise Hotel",
      phone: "+91 98765 43210",
      duration_seconds: 180,
      outcome: "interested",
      created_at: "2026-03-14T10:30:00.000Z",
    },
    {
      id: 2,
      lead_id: 102,
      campaign_id: 1,
      name: "Grand Plaza Hotel",
      phone: "+91 91234 56789",
      duration_seconds: 95,
      outcome: "callback",
      created_at: "2026-03-14T09:15:00.000Z",
    },
    {
      id: 3,
      lead_id: 103,
      campaign_id: 2,
      name: "Seaside Resort",
      phone: "+91 99887 66554",
      duration_seconds: 240,
      outcome: "converted",
      created_at: "2026-03-13T16:45:00.000Z",
    },
  ];

  res.json({
    success: true,
    data: calls,
  });
};

const getRevenue = (req, res) => {
  // One response for all three dashboard cards: Revenue per month, Calls per month, Conversion rate
  const revenue_per_month = [
    { month: "Oct 2025", revenue: 8500 },
    { month: "Nov 2025", revenue: 12000 },
    { month: "Dec 2025", revenue: 15800 },
    { month: "Jan 2026", revenue: 14200 },
    { month: "Feb 2026", revenue: 18900 },
    { month: "Mar 2026", revenue: 22400 },
  ];
  const calls_per_month = [
    { month: "Oct 2025", calls: 180 },
    { month: "Nov 2025", calls: 220 },
    { month: "Dec 2025", calls: 195 },
    { month: "Jan 2026", calls: 248 },
    { month: "Feb 2026", calls: 212 },
    { month: "Mar 2026", calls: 192 },
  ];
  const conversion_per_month = [
    { month: "Oct 2025", rate: 8 },
    { month: "Nov 2025", rate: 10 },
    { month: "Dec 2025", rate: 11 },
    { month: "Jan 2026", rate: 12 },
    { month: "Feb 2026", rate: 14 },
    { month: "Mar 2026", rate: 12.5 },
  ];

  res.json({
    success: true,
    data: {
      revenue: revenue_per_month.reduce((s, m) => s + m.revenue, 0),
      currency: "INR",
      transaction_count: 127,
      revenue_per_month,
      calls_per_month,
      conversion_per_month,
      conversion_rate: 12.5,
    },
  });
};

module.exports = {
  getStats,
  getRecentCalls,
  getRevenue,
};

