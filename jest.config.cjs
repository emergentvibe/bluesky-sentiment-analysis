module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/src/**/*.test.ts', // Look for .test.ts files within any subdirectory of src
    '**/src/server/**/*.test.ts' // Specifically include tests in src/server
  ],
  moduleNameMapper: {
    // Handle module paths, especially if you use path aliases in tsconfig.json (though not apparent here)
    // For ES Modules, ensure jest handles them correctly if you encounter issues.
    // Example for handling .js extensions in imports from .ts files if needed:
    // '(.*)\.js$': '$1' 
  },
  // Automatically clear mock calls and instances between every test
  clearMocks: true,
}; 