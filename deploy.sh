#!/bin/bash

# Azure App Service Deployment Script
echo "Starting deployment..."

# Install backend dependencies
echo "Installing backend dependencies..."
npm install --production

# Build React app
echo "Building React app..."
cd MindMapBoDoi/project-d10
npm install
npm run build
cd ../..

echo "Deployment completed successfully!"
