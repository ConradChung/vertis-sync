export default function Home() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-white mb-4">NorthStar CRM</h1>
        <p className="text-gray-400 mb-8">Lead Generation Dashboard</p>
        <a
          href="/login"
          className="inline-block px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors"
        >
          Sign In
        </a>
      </div>
    </div>
  );
}
